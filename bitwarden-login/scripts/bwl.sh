#!/bin/zsh
# bwl.sh: let an OpenClaw agent log in to sites with passwords it never sees. Backed by a Bitwarden vault for the agent.
#   bwl.sh list                       sites the agent may log in to (names and hosts only)
#   bwl.sh login <site> [--here]      open the saved login page in the OpenClaw browser, fill it, submit
#                                     --here: fill the tab already open on that site (social login: after clicking "Sign in with <site>")
#   bwl.sh code <site> <code>         type a 2FA code the human gave you into that site's open tab
#   bwl.sh add <site> <https-url> [username] [--local]
#                                     ask the human to save a login: prints a one-time link (tailnet only, 10 min);
#                                     --local shows a macOS password dialog instead
#   bwl.sh setup                      one-time, run by the human in a terminal: bw login + save the unlock password to the Keychain
# Only items in the Bitwarden folder "claw" are used. Nothing here prints, logs or passes a password on a command line:
# secrets move through pipes only (no here-strings: zsh writes those to temp files).
# Env: BWL_FOLDER (claw), BWL_TS_PORT (8443), BWL_WAKE (1: wake the agent after a save), BWL_LOG (~/.openclaw/workspace/data/bitwarden-login.log), BWL_CDP (browser debug URL)
set -u
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
DIR=${0:A:h}
KC=openclaw-bitwarden-login
FOLDER=${BWL_FOLDER:-claw}
LOG=${BWL_LOG:-$HOME/.openclaw/workspace/data/bitwarden-login.log}
TSPORT=${BWL_TS_PORT:-8443}   # tailnet https port for the add page (443 is often taken by other serve configs)
LOCKDIR=${TMPDIR:-/tmp}/bwl.lock
cmd=${1:-help}; site=${2:-}
unlocked=0
trap '(( unlocked )) && { bw lock >/dev/null 2>&1; rmdir $LOCKDIR 2>/dev/null }' EXIT   # top level: a trap set in a function fires when it returns

log() { mkdir -p ${LOG:h}; print -r -- "$(date '+%F %T')	$cmd	${site:--}	$1" >> $LOG }
die() { jq -cn --arg s $1 --arg h ${2:-} '{ok:false, status:$s} + (if $h != "" then {hint:$h} else {} end)'; log $1; exit 1 }

unlock() {
  local i
  for i in {1..60}; do
    mkdir $LOCKDIR 2>/dev/null && break
    [[ -n $(find $LOCKDIR -maxdepth 0 -mmin +5 2>/dev/null) ]] && rmdir $LOCKDIR 2>/dev/null   # stale lock
    (( i == 60 )) && die busy "another bwl.sh run is using the vault; try again"
    sleep 1
  done
  unlocked=1
  [[ $(bw status 2>/dev/null | jq -r .status) == unauthenticated ]] && die not-set-up "the human must run: bwl.sh setup"
  export BW_SESSION=$(BWL_PW=$(security find-generic-password -s $KC -w 2>/dev/null) bw unlock --passwordenv BWL_PW --raw 2>/dev/null)
  [[ -n $BW_SESSION ]] || die unlock-failed "unlock password in the Keychain is missing or wrong: the human must run bwl.sh setup"
  bw sync >/dev/null 2>&1
  fid=$(bw list folders --search $FOLDER 2>/dev/null | jq -r --arg f $FOLDER '[.[] | select(.name == $f)][0].id // empty')
}
relock() { bw lock >/dev/null 2>&1; unset BW_SESSION }

# the vault item for $site (name match, case-insensitive) as JSON; dies if missing
item() {
  [[ -n $fid ]] || die no-folder "no \"$FOLDER\" folder in the vault yet: save a login with bwl.sh add first"
  local it=$(bw list items --folderid $fid 2>/dev/null | jq -c --arg s ${site:l} '[.[] | select(.type == 1 and (.name | ascii_downcase) == $s)][0] // empty')
  [[ -n $it ]] || die unknown-site "no saved login named \"$site\"; see bwl.sh list, or ask the human to save it (bwl.sh add)"
  print -r -- $it
}

case $cmd in
list)
  unlock
  [[ -n $fid ]] || { print '[]'; exit 0 }
  bw list items --folderid $fid 2>/dev/null \
    | jq -c '[.[] | select(.type == 1) | {site: .name, host: ((.login.uris[0].uri // "") | sub("^[a-z]+://"; "") | split("/")[0])}]'
  log ok ;;

login)
  [[ -n $site ]] || die usage "bwl.sh login <site>"
  unlock
  it=$(item) || { print -r -- $it; exit 1 }
  relock
  res=$(print -r -- $it | jq -c --argjson here $([[ ${3:-} == --here ]] && echo true || echo false) '{mode: "login", here: $here, url: .login.uris[0].uri, username: (.login.username // ""), password: (.login.password // ""),
      hints: ((.fields // []) | map(select(.name | startswith("claw-"))) | map({key: (.name | ltrimstr("claw-")), value}) | from_entries)}' \
    | node $DIR/fill.mjs)
  it=''
  print -r -- $res
  log $(jq -r .status <<< $res) ;;

code)
  [[ -n $site && ${3:-} == <-> ]] || die usage "bwl.sh code <site> <digits>"
  unlock
  it=$(item) || { print -r -- $it; exit 1 }
  relock
  res=$(print -r -- $it | jq -c --arg c $3 '{mode: "code", url: .login.uris[0].uri, code: $c}' | node $DIR/fill.mjs)
  it=''
  print -r -- $res
  log $(jq -r .status <<< $res) ;;

add)
  url=${3:-}; user=${4:--}; [[ $user == --local ]] && user=-
  [[ $site =~ '^[A-Za-z0-9._-]{1,40}$' ]] || die usage "bwl.sh add <site> <https-url> [username] [--local]; site is a short name like netflix"
  [[ $url =~ '^https://[A-Za-z0-9.-]+\.[A-Za-z]{2,}(:[0-9]+)?(/[^"\\ ]*)?$' ]] || die usage "the login url must be a plain https:// address"
  if [[ " $* " == *" --local "* ]]; then
    ask() { osascript -e "text returned of (display dialog \"$1\" default answer \"\" $2 with title \"Save login for $site\" buttons {\"Cancel\",\"Save\"} default button \"Save\")" 2>/dev/null }
    [[ $user == - ]] && { user=$(ask "Username or email for ${url#https://}" "") || die cancelled }
    ask "Password for ${url#https://} (goes straight to the agent's vault, never to the agent)" "with hidden answer" \
      | jq -cR --arg s $site --arg u $url --arg n $user '{site: $s, url: $u, username: $n, password: .}' | ${0:A} _save || exit 1
    print -r -- '{"ok":true,"status":"saved"}'; exit 0
  fi
  host=$(tailscale status --json 2>/dev/null | jq -r 'select(.BackendState == "Running") | .Self.DNSName // empty' | sed 's/\.$//')
  [[ -n $host ]] || die no-tailscale "Tailscale is not running; use --local at the Mac, or the human adds it in the Bitwarden app (folder \"$FOLDER\")"
  key=$(openssl rand -hex 24); mnt=/bwl-$(openssl rand -hex 6); pf=$(mktemp -t bwl)
  # the server detaches itself and removes the mount when the page is used or expires
  BWL_KEY=$key BWL_SAVE="${0:A} _save" BWL_MNT=$mnt BWL_TS_PORT=$TSPORT node $DIR/add-server.mjs $site $url $user $pf
  for i in {1..50}; do [[ -s $pf ]] && break; sleep 0.1; done
  [[ -s $pf ]] || die server-failed
  port=$(<$pf); rm -f $pf
  tailscale serve --bg --https=$TSPORT --set-path $mnt http://127.0.0.1:$port >/dev/null 2>&1 || die tailscale-serve-failed
  jq -cn --arg l "https://$host:$TSPORT$mnt?k=$key" '{ok:true, status:"link", link:$l, expires:"10 min, one use",
    hint:"send the link to the human; only devices on their tailnet can open it. Do not open it yourself."}'
  log link ;;

_save)   # internal: one line of login JSON on stdin {site,url,username,password}, from the add page or dialog
  read -r in
  site=$(print -r -- $in | jq -r .site)
  [[ -n $(print -r -- $in | jq -r '.password // empty') ]] || die empty-password
  unlock
  [[ -n $fid ]] || fid=$(jq -cn --arg f $FOLDER '{name:$f}' | bw encode | bw create folder 2>/dev/null | jq -r .id)
  [[ -n $fid ]] || die save-failed "could not create the \"$FOLDER\" folder"
  id=$(bw list items --folderid $fid 2>/dev/null | jq -r --arg s ${site:l} '[.[] | select(.type == 1 and (.name | ascii_downcase) == $s)][0].id // empty')
  if [[ -n $id ]]; then   # changing a saved login (the human typed it in the form); its site stays fixed
    h() { jq -r "$1" | sed -E 's|^[a-z]+://||; s|[/:?#].*||; s|^www\.||' }
    old=$(bw get item $id 2>/dev/null | h '.login.uris[0].uri // ""'); new=$(print -r -- $in | h .url)
    [[ $old == $new ]] || die host-changed "\"$site\" is saved for $old, not $new; to really move it, change the website in the Bitwarden app"
    { bw get item $id 2>/dev/null; print -r -- $in } | jq -cs '.[0] * {login: {username: .[1].username, password: .[1].password, uris: [{match: null, uri: .[1].url}]}}' \
      | bw encode | bw edit item $id >/dev/null 2>&1 || die save-failed
  else
    print -r -- $in | jq -c --arg f $fid '{organizationId: null, collectionIds: null, folderId: $f, type: 1, name: .site, notes: "Saved by openclaw-bitwarden-login",
        favorite: false, fields: [], reprompt: 0, login: {uris: [{match: null, uri: .url}], username: .username, password: .password, totp: null}}' \
      | bw encode | bw create item >/dev/null 2>&1 || die save-failed
  fi
  in=''
  log saved
  # wake the agent so it carries on with whatever was waiting for this login (BWL_WAKE=0 turns this off)
  # in the background: the save page waits for this script, and a busy agent can take minutes to accept the wake
  [[ ${BWL_WAKE:-1} == 1 ]] && { openclaw system event --mode now --text "bitwarden-login: the user just saved the \"$site\" login with the one-time link. If you were waiting for it, continue now (bwl.sh login $site); otherwise just confirm it is saved in one line." >/dev/null 2>&1 &! }
  : ;;

setup)
  [[ -t 0 ]] || die usage "run bwl.sh setup yourself in a terminal (it asks for passwords)"
  print "1/3 Log in to the Bitwarden account made for the agent (not your personal one)."
  [[ $(bw status | jq -r .status) == unauthenticated ]] && { bw login || exit 1; print "(Ignore the session key above: it stops working when setup locks the vault. Don't paste it anywhere.)" }
  print "2/3 Type that account's master password again; it is saved only to the macOS Keychain (item \"$KC\")."
  security add-generic-password -U -s $KC -a bitwarden -T /usr/bin/security -w || exit 1
  print "3/3 Checking unlock..."
  unlock
  [[ -n $fid ]] || jq -cn --arg f $FOLDER '{name:$f}' | bw encode | bw create folder >/dev/null
  print "Done. Logins in the \"$FOLDER\" folder are now usable by the agent."
  log ok ;;

*) sed -n '2,11p' $0 | sed 's/^# \{0,1\}//' ;;
esac
exit 0
