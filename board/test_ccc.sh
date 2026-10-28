#!/bin/bash
# Checks ccc without opening a browser: a fake `open` records what it was asked.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
WORK="$(mktemp -d)"
export CCC_PORT=18765
export CCC_SESSIONS_DIR="$WORK/sessions"
export CCC_REMOVED_FILE="$WORK/removed.json"
export CCC_NOTES_FILE="$WORK/notes.json"
SQUAT_PORT=18766
PASSED=0
FAILED=0

cleanup() {
  CCC_PORT=$CCC_PORT "$HERE/ccc" stop --force >/dev/null 2>&1
  [ -n "${SQUATTER:-}" ] && kill "$SQUATTER" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/bin"
cat >"$WORK/bin/open" <<EOF
#!/bin/bash
echo "\$*" >>"$WORK/open.log"
EOF
chmod +x "$WORK/bin/open"
export PATH="$WORK/bin:$PATH"

check() {
  if [ "$2" = "$3" ]; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "FAIL: $1 (expected '$3', got '$2')"
  fi
}

"$HERE/ccc" </dev/null >/dev/null 2>&1
check "opens the board and exits 0 when not asked to close" "$?" "0"
check "the server answers" "$(curl -fsS "http://127.0.0.1:$CCC_PORT/api/health")" '{"app": "ccc", "ok": true}'
check "the window is an app window on the board" "$(grep -c -- "--app=http://127.0.0.1:$CCC_PORT/" "$WORK/open.log")" "1"

"$HERE/ccc" </dev/null >/dev/null 2>&1
check "a second run reuses the running server" "$(lsof -t -nP -iTCP:"$CCC_PORT" -sTCP:LISTEN | wc -l | tr -d ' ')" "1"

check "the board page is served" "$(curl -fsS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CCC_PORT/")" "200"
check "other files are not served" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CCC_PORT/serve.py")" "404"
check "a foreign host name is refused" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' "http://127.0.0.1:$CCC_PORT/api/sessions")" "403"

URL="http://127.0.0.1:$CCC_PORT/api/remove"
check "a removal without the board's header is refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"sessionId":"s1"}' "$URL")" "403"
check "a removal from another site is refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-CCC-Action: remove' -H 'Origin: https://evil.example' -d '{"sessionId":"s1"}' "$URL")" "403"
check "a removal naming a bad id is refused" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-CCC-Action: remove' -d '{"sessionId":"../x"}' "$URL")" "400"
check "a removal from the board is accepted" "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'X-CCC-Action: remove' -H "Origin: http://127.0.0.1:$CCC_PORT" -d '{"sessionId":"s1"}' "$URL")" "200"
check "the removal is remembered" "$(python3 -c 'import json,sys; print(list(json.load(open(sys.argv[1]))["removed"]))' "$CCC_REMOVED_FILE")" "['s1']"

"$HERE/ccc" nonsense >/dev/null 2>&1
check "an unknown argument exits 2" "$?" "2"

# a terminal on the board: stop asks first, and with no one to ask it stops nothing
BASE="http://127.0.0.1:$CCC_PORT"
KEY="$(curl -fsS -H 'Sec-Fetch-Site: same-origin' "$BASE/api/terminals/key" | python3 -c 'import json,sys; print(json.load(sys.stdin)["key"])')"
mkdir -p "$WORK/shell"
curl -fsS -X POST -H 'Content-Type: application/json' -H 'X-CCC-Action: terminal-start' -H "X-CCC-Key: $KEY" -d "{\"folder\": \"$WORK/shell\"}" "$BASE/api/terminal/start" >/dev/null
OUT="$("$HERE/ccc" stop </dev/null 2>&1)"
check "stop with a terminal running exits 1" "$?" "1"
check "stop with a terminal running says what it would end" "$(echo "$OUT" | grep -c 'Are you sure? This will terminate all active terminals: 1 terminal')" "1"
check "stop with a terminal running leaves the server up" "$(curl -fsS "$BASE/api/health")" '{"app": "ccc", "ok": true}'

"$HERE/ccc" stop --force >/dev/null 2>&1
sleep 0.3
check "stop stops the server" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$CCC_PORT/api/health")" "000"

"$HERE/ccc" stop >/dev/null 2>&1
check "stop with no server running exits 0" "$?" "0"

python3 -m http.server "$SQUAT_PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SQUATTER=$!
disown "$SQUATTER"
sleep 0.5
CCC_PORT=$SQUAT_PORT "$HERE/ccc" </dev/null >/dev/null 2>&1
check "a port taken by something else exits 1" "$?" "1"

echo "ccc: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
