# bitwarden-login: an OpenClaw skill

English | [日本語](README.ja.md)

Lets an [OpenClaw](https://github.com/openclaw/openclaw) agent log in to websites **with passwords it never sees**, and lets you save logins through a one-time secure page instead of typing them in chat.

- **Use, but never see.** `bwl.sh login netflix` takes the login from Bitwarden and types it straight into the OpenClaw browser. The agent only gets `{"status":"logged-in"}`. There is no command that shows a password.
- **Only on the right site.** A password is typed only if the page is https and on the host saved with it (or a subdomain of it). If a message tricks the agent into opening a look-alike page, nothing is typed.
- **Save without chat.** `bwl.sh add netflix https://www.netflix.com/login` gives the agent a one-time link to send you. You open it on your phone, type the password into a normal password field, and it goes straight into the vault.
- **2FA stays with you.** When a site asks for a code, the agent asks you for it. 2FA secrets are never stored.

## How it keeps passwords away from the agent

| Risk | What the tool does |
|---|---|
| The agent reads a password | No command outputs one. Scripts print only a status. The skill tells the agent not to run `bw` or read the Keychain itself. |
| A password leaks into logs or the process list | Passwords move only through pipes, never command-line arguments. The browser is driven directly over the DevTools socket, so OpenClaw's tool logs never see them. `tests/leak-test.sh` checks this for the browser filler (`fill.mjs`). |
| Prompt injection sends the agent to a phishing page | A password is typed only on https pages of the saved site, checked again right before each field. |
| The agent gets into your other accounts | The agent has **its own Bitwarden account**, with only the logins you give it, and only items in its `claw` folder are used. |
| The vault stays open | It is unlocked for each command and locked again right after. Its unlock password is kept in the macOS Keychain, not in a file. |
| A tricked agent moves a saved login to another site | Saving over an existing login keeps its site: a new address is refused (`host-changed`), and only you can change it in the Bitwarden app. |
| The save link is misused | It works only on your Tailscale network, carries a random key, works once and expires after 10 minutes. The page sends nothing anywhere else. |
| You can't see what happened | Every command is written to `~/.openclaw/workspace/data/bitwarden-login.log`: time, command, site, result. Never a password. |

**What it can't protect against:** a site that has itself been hacked, malware already running as your user on the Mac (it could read the Keychain item too), an agent that ignores the skill and runs `bw` or `security` itself (keep those two off the OpenClaw exec allowlist so it has to ask you first), or you approving a login the agent should not do. A logged-in browser session is as powerful as the password, so only save logins you are happy for the agent to use.

The scripts are short, so you can read them: `scripts/bwl.sh` (vault), `scripts/fill.mjs` (browser), `scripts/add-server.mjs` (save page).

## Install

```sh
brew install bitwarden-cli jq
git clone https://github.com/hlum/openclaw-bitwarden-login
cp -r openclaw-bitwarden-login/bitwarden-login ~/.openclaw/workspace/skills/
```

1. Make a **new free Bitwarden account just for the agent**. Don't use your personal vault. (For a self-hosted or EU server, run `bw config server <url>` first.)
2. In a terminal, run `~/.openclaw/workspace/skills/bitwarden-login/scripts/bwl.sh setup`. It logs in to that account, saves its master password to the macOS Keychain, and makes the `claw` folder.
3. Optional: allow the agent to run it without asking each time:
   `openclaw approvals allowlist add --agent main "~/.openclaw/workspace/skills/bitwarden-login/scripts/bwl.sh"`
   Without this, every login waits for your approval, which is the safer default. With it, unattended runs (cron jobs, heartbeats) can log in too, and only the skill's instructions stop them.

Needs the OpenClaw browser running (its debug port, default `http://127.0.0.1:18800`, set `BWL_CDP` otherwise) and Node 22+. The save link needs [Tailscale](https://tailscale.com) on the Mac and on your phone. Without it, use `add ... --local` at the Mac, or add logins in the Bitwarden app (put them in the `claw` folder).

## Use

```sh
S=~/.openclaw/workspace/skills/bitwarden-login/scripts
$S/bwl.sh list                                         # [{"site":"netflix","host":"www.netflix.com"}]
$S/bwl.sh login netflix                                # {"ok":true,"status":"logged-in",...}
$S/bwl.sh code netflix 123456                          # after "needs-code"
$S/bwl.sh add netflix https://www.netflix.com/login    # one-time link for you
```

Most sites need nothing extra, including two-step logins (email page, then password page). For an odd login page, add custom fields to the item in Bitwarden: `claw-user`, `claw-pass`, `claw-next`, with CSS selectors as values.

Settings (env): `BWL_FOLDER` (`claw`), `BWL_LOG`, `BWL_CDP`, `BWL_TS_PORT` (tailnet port for the save page, `8443`).

## Test

```sh
~/.openclaw/workspace/skills/bitwarden-login/tests/leak-test.sh
```

This runs the filler against a fake login site in the real OpenClaw browser: one-page, two-step and 2FA logins, plus a redirect to another host and plain http, which must both be refused. Then it checks that the random test password appears nowhere except on the fake site: not in output, OpenClaw logs, agent sessions or the process list. No Bitwarden account is needed for the test.

## Limits

- Logins inside iframes and passkey-only sites are not supported. CAPTCHAs need you once.
- Social logins ("Sign in with Google/LINE/…"): the agent asks you which one you use and saves only that provider's login. It clicks the button, then `bwl.sh login <provider> --here` fills the provider page.
- macOS only (Keychain, `osascript`).

> Automated logins can break a site's terms of service. Use it for your own accounts.

## License

MIT
