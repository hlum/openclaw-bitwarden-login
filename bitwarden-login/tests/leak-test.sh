#!/bin/zsh
# Runs fill.mjs against a fake local login site in the real OpenClaw browser, then checks
# that a random password reached the site and nowhere else (stdout, process list, OpenClaw logs and sessions).
# No Bitwarden needed. Usage: tests/leak-test.sh   (OpenClaw browser must be running)
set -u
cd ${0:A:h}
FILL=../scripts/fill.mjs
tmp=$(mktemp -d); trap 'kill $srv 2>/dev/null; rm -rf $tmp' EXIT
node login-site.mjs $tmp/port $tmp/record & srv=$!
for i in {1..50}; do [[ -s $tmp/port ]] && break; sleep 0.1; done
B=http://127.0.0.1:$(<$tmp/port)
PW="pw-$(openssl rand -hex 12)"
fails=0
check() { if eval $2; then print "ok   $1"; else print "FAIL $1: $r"; fails=$((fails+1)); fi }
run() { BWL_ALLOW_HTTP_LOCAL=1 node $FILL | tee -a $tmp/stdout }

r=$(jq -cn --arg u $B/one --arg p $PW '{mode:"login", url:$u, username:"tester", password:$p}' | run)
check "one-page login submits"        '[[ $(jq -r .status <<< $r) == logged-in ]] && grep -q "/done username=tester&password=$PW" $tmp/record'

r=$(jq -cn --arg u $B/two --arg p $PW '{mode:"login", url:$u, username:"tester", password:$p}' | run)
check "two-step login submits"        '[[ $(jq -r .status <<< $r) == logged-in ]] && grep -q "/done password=$PW" $tmp/record'

curl -s -X PUT "${BWL_CDP:-http://127.0.0.1:18800}/json/new?$B/one" >/dev/null; sleep 2   # a tab "after a Sign in with … click"
r=$(jq -cn --arg u $B/somewhere --arg p $PW '{mode:"login", url:$u, username:"tester", password:$p, here:true}' | run)
check "--here fills the open tab"     '[[ $(jq -r .status <<< $r) == logged-in ]] && [[ $(grep -c "/done username=tester&password=$PW" $tmp/record) == 2 ]]'

r=$(jq -cn --arg u $B/otp --arg p $PW '{mode:"login", url:$u, username:"tester", password:$p}' | run)
check "2FA page is reported"          '[[ $(jq -r .status <<< $r) == needs-code ]]'
r=$(jq -cn --arg u $B/otp '{mode:"code", url:$u, code:"123456"}' | run)
check "2FA code is typed"             '[[ $(jq -r .status <<< $r) == logged-in ]] && grep -q "/done code=123456" $tmp/record'

: > $tmp/record
r=$(jq -cn --arg u $B/away --arg p $PW '{mode:"login", url:$u, username:"tester", password:$p}' | run)
check "redirect to another host is refused, nothing typed" '[[ $(jq -r .status <<< $r) == wrong-site && ! -s $tmp/record ]]'

r=$(jq -cn --arg u $B/one --arg p $PW '{mode:"login", url:$u, username:"tester", password:$p}' | node $FILL | tee -a $tmp/stdout)
check "plain http is refused, nothing typed" '[[ $(jq -r .status <<< $r) == wrong-site && ! -s $tmp/record ]]'

# leak scan: the password must appear only in the fake site's record
check "password not in fill.mjs output"   '! grep -q $PW $tmp/stdout'
check "password not in OpenClaw logs"     '! grep -rqs $PW /tmp/openclaw/'
check "password not in OpenClaw sessions" '! grep -rqs $PW ~/.openclaw/agents/'
check "password not in the process list"  '! ps -axww -o args | grep -v grep | grep -q $PW'

# close the tabs the test opened
CDP=${BWL_CDP:-http://127.0.0.1:18800}
curl -s $CDP/json/list | jq -r --arg p ":$(<$tmp/port)/" '.[] | select(.url | contains($p)) | .id' | while read -r t; do curl -s $CDP/json/close/$t >/dev/null; done

(( fails )) && { print "$fails failed"; exit 1 }
print "all passed"
