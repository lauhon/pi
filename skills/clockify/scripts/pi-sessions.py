#!/usr/bin/env python3
"""Summarize pi sessions active on a given day: time span (local), Jira keys, branches, user prompts.

Usage: pi-sessions.py [YYYY-MM-DD] [--ticket-prefix DPSCEP]
"""
import argparse
import glob
import json
import os
import re
from collections import Counter
from datetime import date, datetime

SESSIONS = os.path.expanduser("~/.pi/agent/sessions")


def local(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("day", nargs="?", default=date.today().isoformat())
    p.add_argument("--ticket-prefix", default="DPSCEP")
    args = p.parse_args()
    day = date.fromisoformat(args.day)
    ticket_re = re.compile(rf"{re.escape(args.ticket_prefix)}-\d+")
    cutoff = datetime.combine(day, datetime.min.time()).timestamp()

    files = [f for f in glob.glob(f"{SESSIONS}/*/*.jsonl") if os.path.getmtime(f) >= cutoff]
    for f in sorted(files, key=os.path.basename):
        cwd = None; ts = []; users = []; tickets = Counter(); branches = Counter()
        with open(f) as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except ValueError:
                    continue
                if e.get("type") == "session":
                    cwd = e.get("cwd")
                t = e.get("timestamp")
                if not isinstance(t, str):
                    continue
                lt = local(t)
                if lt.date() != day:
                    continue
                ts.append(lt)
                msg = e.get("message") or {}
                if msg.get("role") == "system":
                    continue
                tickets.update(ticket_re.findall(line))
                branches.update(re.findall(r"(?:feat|fix|chore)/[A-Za-z0-9._-]+", line))
                if msg.get("role") == "user":
                    c = msg.get("content")
                    if isinstance(c, list):
                        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                    users.append((lt.strftime("%H:%M"), (c or "").replace("\n", " ")[:220]))
        if not users:
            continue
        print("=====", os.path.basename(f), cwd)
        print("span", min(ts).strftime("%H:%M"), "-", max(ts).strftime("%H:%M"), "local, entries", len(ts))
        print("tickets", tickets.most_common(8))
        print("branches", branches.most_common(4))
        for when, text in users:
            print("  U", when, text)


if __name__ == "__main__":
    main()
