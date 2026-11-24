#!/usr/bin/env bash
# TEMPORARY workaround while acli machine access is down.
# Calls the Jira REST API from inside the logged-in cmux browser tab, so the session cookie authenticates.
#
#   jira-browser.sh get  KEY [out.json]   # writes the description ADF (default /tmp/KEY.desc.json)
#   jira-browser.sh put  KEY adf.json     # replaces the description with the ADF doc in adf.json
#   jira-browser.sh json KEY body.json    # PUT an arbitrary /rest/api/3/issue body ({"fields":{...}})
#
# Env: JIRA_SURFACE (default: first browser surface showing atlassian.net, else opens one)
set -euo pipefail

BASE=https://redbull-gms.atlassian.net
cmd=${1:?get|put|json}; key=${2:?issue key}

surface() {
  if [[ -n "${JIRA_SURFACE:-}" ]]; then echo "$JIRA_SURFACE"; return; fi
  local s
  s=$(cmux tree --json | jq -r '[.. | objects | select(.ref? and (.url? // "" | test("atlassian.net")))] | first | .ref // empty')
  if [[ -z "$s" ]]; then
    s=$(cmux browser open "$BASE/browse/$key" | grep -o 'surface:[0-9]*' | head -1)
    cmux browser "$s" wait --load-state complete --timeout-ms 20000 >/dev/null
  fi
  echo "$s"
}

S=$(surface)
b64() { base64 < "$1" | tr -d '\n'; }
# Decode as UTF-8; plain atob() would mangle non-ASCII characters.
DECODE='new TextDecoder().decode(Uint8Array.from(atob(B),c=>c.charCodeAt(0)))'

put_body() {
  cmux browser "$S" eval "(()=>{const B='$(b64 "$1")';return fetch('/rest/api/3/issue/$key',{method:'PUT',headers:{'Content-Type':'application/json','X-Atlassian-Token':'no-check'},body:$DECODE}).then(async r=>r.status+' '+(await r.text()))})()"
}

case "$cmd" in
  get)
    out=${3:-/tmp/$key.desc.json}
    cmux browser "$S" eval "fetch('/rest/api/3/issue/$key?fields=description').then(r=>r.json()).then(j=>JSON.stringify(j.fields.description))" | jq . > "$out"
    echo "$out"
    ;;
  put)
    tmp=$(mktemp); jq '{fields:{description:.}}' "${3:?adf.json}" > "$tmp"
    put_body "$tmp"; rm -f "$tmp"
    ;;
  json)
    put_body "${3:?body.json}"
    ;;
  *) echo "unknown command: $cmd" >&2; exit 2 ;;
esac
