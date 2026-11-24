#!/usr/bin/env python3
"""Minimal Clockify REST client using only the Python standard library.

The API key comes from CLOCKIFY_API_KEY or the macOS Keychain item
"clockify-api-key", so it never appears in shell history or agent context.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time, timedelta, timezone

API_URL = os.environ.get("CLOCKIFY_API_URL", "https://api.clockify.me/api").rstrip("/")
KEYCHAIN_SERVICE = "clockify-api-key"


def api_key() -> str:
    key = os.environ.get("CLOCKIFY_API_KEY")
    if key:
        return key
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-a", os.environ.get("USER", ""), "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, check=True,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        sys.exit(
            "No API key. Store it once with:\n"
            f'  security add-generic-password -a "$USER" -s {KEYCHAIN_SERVICE} -w'
        )
    return out.stdout.strip()


def request(method: str, path: str, params: dict | None = None, body: dict | None = None):
    url = f"{API_URL}{path}"
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-Api-Key", api_key())
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 429:
            sys.exit("HTTP 429: Clockify free plan allows 30 requests per hour. Re-run later, existing entries are skipped.")
        sys.exit(f"HTTP {e.code} {method} {path}: {e.read().decode(errors='replace')[:500]}")
    except urllib.error.URLError as e:
        sys.exit(f"Network error {method} {path}: {e.reason}")
    return json.loads(raw) if raw else None


_ME: dict | None = None


def me() -> dict:
    global _ME
    if _ME is None:
        _ME = request("GET", "/v1/user")
    return _ME


def workspace_id(user: dict) -> str:
    return os.environ.get("CLOCKIFY_WORKSPACE_ID") or user["activeWorkspace"]


def to_utc(local: str) -> str:
    """Parse 'YYYY-MM-DD HH:MM' (or ISO) in the local timezone, return Clockify's UTC format."""
    dt = datetime.fromisoformat(local)
    if dt.tzinfo is None:
        dt = dt.astimezone()
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def day_bounds(day: str) -> tuple[str, str]:
    d = date.fromisoformat(day)
    start = datetime.combine(d, time.min).astimezone()
    end = start + timedelta(days=1)
    fmt = "%Y-%m-%dT%H:%M:%SZ"
    return start.astimezone(timezone.utc).strftime(fmt), end.astimezone(timezone.utc).strftime(fmt)


def resolve_project(ws: str, name_or_id: str | None) -> str | None:
    if not name_or_id:
        return None
    if re.fullmatch(r"[0-9a-f]{24}", name_or_id):
        return name_or_id
    projects = request("GET", f"/v1/workspaces/{ws}/projects", {"name": name_or_id, "page-size": 200})
    exact = [p for p in projects if p["id"] == name_or_id or p["name"].lower() == name_or_id.lower()]
    if len(exact) == 1:
        return exact[0]["id"]
    if len(projects) == 1:
        return projects[0]["id"]
    names = ", ".join(p["name"] for p in projects) or "none"
    sys.exit(f"Project '{name_or_id}' is ambiguous or unknown. Matches: {names}")


def resolve_task(ws: str, project_id: str | None, name_or_id: str | None) -> str | None:
    if not name_or_id:
        return None
    if not project_id:
        sys.exit("A task needs a project.")
    if re.fullmatch(r"[0-9a-f]{24}", name_or_id):
        return name_or_id
    tasks = request("GET", f"/v1/workspaces/{ws}/projects/{project_id}/tasks", {"name": name_or_id, "page-size": 200})
    exact = [t for t in tasks if t["id"] == name_or_id or t["name"].lower() == name_or_id.lower()]
    if len(exact) == 1:
        return exact[0]["id"]
    names = ", ".join(t["name"] for t in tasks) or "none"
    sys.exit(f"Task '{name_or_id}' is ambiguous or unknown. Matches: {names}")


def list_entries(ws: str, uid: str, day: str) -> list[dict]:
    start, end = day_bounds(day)
    return request("GET", f"/v1/workspaces/{ws}/user/{uid}/time-entries",
                   {"start": start, "end": end, "page-size": 500})


def fmt_local(utc: str | None) -> str:
    if not utc:
        return "running"
    return datetime.fromisoformat(utc.replace("Z", "+00:00")).astimezone().strftime("%H:%M")


def cmd_whoami(_args):
    u = me()
    ws = workspace_id(u)
    print(json.dumps({"user": u["name"], "email": u["email"], "userId": u["id"], "workspaceId": ws}, indent=2))


def cmd_workspaces(_args):
    for w in request("GET", "/v1/workspaces"):
        print(f"{w['id']}  {w['name']}")


def cmd_projects(args):
    ws = workspace_id(me())
    for p in request("GET", f"/v1/workspaces/{ws}/projects",
                     {"name": args.name, "archived": "false", "page-size": 200}):
        print(f"{p['id']}  {p['name']}  (client: {p.get('clientName') or '-'}, billable: {p.get('billable')})")


def cmd_tasks(args):
    ws = workspace_id(me())
    pid = resolve_project(ws, args.project)
    for t in request("GET", f"/v1/workspaces/{ws}/projects/{pid}/tasks", {"page-size": 200}):
        print(f"{t['id']}  {t['name']}  ({t.get('status')})")


def cmd_entries(args):
    u = me()
    ws = workspace_id(u)
    total = timedelta()
    for e in sorted(list_entries(ws, u["id"], args.date), key=lambda e: e["timeInterval"]["start"]):
        ti = e["timeInterval"]
        if ti.get("end"):
            total += datetime.fromisoformat(ti["end"].replace("Z", "+00:00")) - datetime.fromisoformat(ti["start"].replace("Z", "+00:00"))
        print(f"{e['id']}  {fmt_local(ti['start'])}-{fmt_local(ti.get('end'))}  {e.get('description') or ''}")
    print(f"total: {total.total_seconds() / 3600:.2f}h")


def build_entry(ws: str, item: dict, defaults: dict) -> dict:
    project_id = resolve_project(ws, item.get("project", defaults.get("project")))
    body = {
        "start": to_utc(item["start"]),
        "end": to_utc(item["end"]),
        "description": item["description"],
        "billable": bool(item.get("billable", defaults.get("billable", False))),
    }
    if project_id:
        body["projectId"] = project_id
    task_id = resolve_task(ws, project_id, item.get("task", defaults.get("task")))
    if task_id:
        body["taskId"] = task_id
    return body


def cmd_book(args):
    """Book a plan file. Dry run unless --apply; skips entries that already exist (same start + description)."""
    plan = json.load(open(args.plan))
    defaults = plan.get("defaults", {})
    items = plan["entries"]
    u = me()
    ws = workspace_id(u)

    days = {datetime.fromisoformat(i["start"]).date().isoformat() for i in items}
    existing = set()
    for d in days:
        for e in list_entries(ws, u["id"], d):
            existing.add((e["timeInterval"]["start"].replace(".000", ""), (e.get("description") or "").strip()))

    created = skipped = 0
    for item in items:
        body = build_entry(ws, item, defaults)
        key = (body["start"], body["description"].strip())
        label = f"{fmt_local(body['start'])}-{fmt_local(body['end'])}  {body['description']}"
        if key in existing:
            print(f"skip (exists)  {label}")
            skipped += 1
            continue
        if not args.apply:
            print(f"would create   {label}")
            continue
        res = request("POST", f"/v1/workspaces/{ws}/time-entries", body=body)
        print(f"created {res['id']}  {label}")
        created += 1
    if not args.apply:
        print("dry run, nothing written. Re-run with --apply.")
    else:
        print(f"created {created}, skipped {skipped}")


def cmd_delete(args):
    ws = workspace_id(me())
    for entry_id in args.ids:
        request("DELETE", f"/v1/workspaces/{ws}/time-entries/{entry_id}")
        print(f"deleted {entry_id}")


def main():
    p = argparse.ArgumentParser(prog="clockify.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("whoami").set_defaults(fn=cmd_whoami)
    sub.add_parser("workspaces").set_defaults(fn=cmd_workspaces)
    sp = sub.add_parser("projects"); sp.add_argument("--name"); sp.set_defaults(fn=cmd_projects)
    sp = sub.add_parser("tasks"); sp.add_argument("project"); sp.set_defaults(fn=cmd_tasks)
    sp = sub.add_parser("entries"); sp.add_argument("--date", default=date.today().isoformat()); sp.set_defaults(fn=cmd_entries)
    sp = sub.add_parser("book"); sp.add_argument("plan"); sp.add_argument("--apply", action="store_true"); sp.set_defaults(fn=cmd_book)
    sp = sub.add_parser("delete"); sp.add_argument("ids", nargs="+"); sp.set_defaults(fn=cmd_delete)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
