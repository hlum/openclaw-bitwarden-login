// One-time "save a login" page. Started by `bwl.sh add`; serves one form, accepts one submit, then exits.
//   node add-server.mjs <site> <url> <username|-> <port-file>
// Env: BWL_KEY (random key the page URL must carry), BWL_TTL (seconds, default 600), BWL_SAVE (command that reads the JSON on stdin),
//      BWL_MNT + BWL_TS_PORT (the `tailscale serve` path `bwl.sh add` publishes; removed here on exit)
// Listens on 127.0.0.1 only. Re-launches itself detached, so it outlives the agent's or cron job's process group.
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';

if (!process.env.BWL_DETACHED) {
  spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: 'ignore', env: { ...process.env, BWL_DETACHED: '1' } }).unref();
  process.exit(0);
}
const [site, url, user, portFile] = process.argv.slice(2);
const KEY = Buffer.from(process.env.BWL_KEY || '');
if (KEY.length < 32) { console.error('BWL_KEY missing'); process.exit(2); }
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const keyOk = k => { const b = Buffer.from(k || ''); return b.length === KEY.length && timingSafeEqual(b, KEY); };
const headers = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
};
const page = (title, body) => `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px;color:#222;background:#fafafa}
@media(prefers-color-scheme:dark){body{color:#eee;background:#161616}input{background:#222;color:#eee;border-color:#444}}
label{display:block;margin:16px 0 4px;font-weight:600}input{width:100%;box-sizing:border-box;font-size:17px;padding:10px;border:1px solid #bbb;border-radius:8px}
button{margin-top:24px;width:100%;padding:12px;font-size:17px;border:0;border-radius:8px;background:#175ddc;color:#fff}.m{color:#888;font-size:14px}</style>${body}`;

let done = false;
// remove the tailnet route a few seconds after the last reply, so the reply can get through the proxy first
const finish = () => { done = true; setTimeout(cleanup, 3000); };
const cleanup = () => {
  if (process.env.BWL_MNT) try { execFileSync('tailscale', ['serve', `--https=${process.env.BWL_TS_PORT || 8443}`, '--set-path', process.env.BWL_MNT, 'off'], { stdio: 'ignore' }); } catch {}
  setTimeout(() => process.exit(0), 300);
};
setTimeout(() => { done = true; cleanup(); }, (Number(process.env.BWL_TTL) || 600) * 1000).unref();

const server = http.createServer((req, res) => {
  const q = new URL(req.url, 'http://x').searchParams;
  if (done || !keyOk(q.get('k'))) { res.writeHead(404, headers); return res.end(page('Gone', '<p>This link has expired or was already used. Ask claw for a new one.')); }
  if (req.method === 'GET') {
    res.writeHead(200, headers);
    return res.end(page(`Save login: ${esc(site)}`, `<h2>Save login for ${esc(site)}</h2>
<p class=m>Used only on <b>${esc(new URL(url).hostname)}</b>. Saved straight to claw's Bitwarden vault; claw never sees the password.</p>
<form method=post action="?k=${esc(KEY)}" autocomplete=off>
<label for=u>Username or email</label><input id=u name=username value="${user === '-' ? '' : esc(user)}" autocapitalize=off autocorrect=off spellcheck=false required>
<label for=p>Password</label><input id=p name=password type=password autocomplete=new-password required>
<button>Save</button></form><p class=m>This link works once and expires in 10 minutes.</p>`));
  }
  if (req.method !== 'POST') { res.writeHead(405, headers); return res.end(); }
  done = true;                                          // one submit only, even if saving fails
  let body = '';
  req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
  req.on('end', () => {
    const f = new URLSearchParams(body); body = '';
    const save = spawn('/bin/zsh', ['-c', process.env.BWL_SAVE], { stdio: ['pipe', 'ignore', 'ignore'] });
    save.stdin.end(JSON.stringify({ site, url, username: f.get('username') || '', password: f.get('password') || '' }));
    // answer at once: saving to Bitwarden takes several seconds, and phones gave up waiting. The agent confirms (or reports a failure) in chat.
    res.writeHead(200, { ...headers, connection: 'close' });
    res.end(page('Received', `<h2>Received ✓</h2><p>Saving ${esc(site)} to the vault now. You'll get a confirmation in chat. You can close this page.`));
    save.on('exit', code => {
      if (code !== 0 && process.env.BWL_WAKE !== '0')
        spawn('openclaw', ['system', 'event', '--mode', 'now', '--text', `bitwarden-login: saving the "${site}" login from the one-time link FAILED. Tell the user and offer a new link (bwl.sh add).`], { stdio: 'ignore', detached: true }).unref();
      finish();
    });
  });
});
server.listen(0, '127.0.0.1', () => writeFileSync(portFile, String(server.address().port)));
