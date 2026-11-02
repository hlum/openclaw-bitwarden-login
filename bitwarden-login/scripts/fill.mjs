// Fills a login form in the OpenClaw browser over the Chrome DevTools Protocol.
// Reads one JSON object on stdin, prints one JSON result on stdout. Secrets never go to argv, stdout or logs.
//   {mode:"login", url, username, password, hints:{user,pass,next}, here?}   open url in a new tab (here: use the open tab
//                                                                     already on that site, e.g. after a "Sign in with LINE" click), fill, submit
//   {mode:"code",  url, code}                                          type a 2FA code into the open tab for url's site
// A value is only typed when the page is https and on the saved site (same host, or a subdomain of it).
// Env: BWL_CDP (default http://127.0.0.1:18800), BWL_ALLOW_HTTP_LOCAL=1 (tests: allow http on 127.0.0.1/localhost)
const CDP = process.env.BWL_CDP || 'http://127.0.0.1:18800';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const out = o => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(o.ok ? 0 : 1); };
setTimeout(() => out({ ok: false, status: 'timeout' }), 60000).unref();

let input = '';
for await (const c of process.stdin) input += c;
let job;
try { job = JSON.parse(input); } catch { out({ ok: false, status: 'bad-input' }); }   // no error text: it could quote the input
input = '';

const base = new URL(job.url).hostname.replace(/^www\./, '');
function siteOk(href) {
  let u; try { u = new URL(href); } catch { return false; }
  const local = process.env.BWL_ALLOW_HTTP_LOCAL === '1' && u.protocol === 'http:' && /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
  return (u.protocol === 'https:' || local) && (u.hostname === base || u.hostname.endsWith('.' + base));
}
const where = href => { try { const u = new URL(href); return u.hostname + u.pathname; } catch { return ''; } };

// --- CDP plumbing (flat sessions over the browser websocket)
const ver = await fetch(CDP + '/json/version').then(r => r.json()).catch(() => null);
if (!ver) out({ ok: false, status: 'no-browser', hint: 'OpenClaw browser is not running (openclaw browser start)' });
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const waiting = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); const w = waiting.get(m.id); if (w) { waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); } };
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId }));
});

let sid, targetId;
const evaluate = async fn => (await send('Runtime.evaluate', { expression: `(${fn})()`, returnByValue: true }, sid)).result.value;
const href = () => evaluate(() => location.href);

// marks the fields on the page (data-bwl=u/p/c/n) and reports what it sees; hints are CSS selectors from the vault item
const scan = async () => evaluate(`() => {
  const h = ${JSON.stringify(job.hints || {})};
  const vis = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  document.querySelectorAll('[data-bwl]').forEach(e => e.removeAttribute('data-bwl'));
  const ins = [...document.querySelectorAll('input')].filter(e => vis(e) && !e.disabled && !e.readOnly);
  const texty = e => /^(text|email|tel)$/.test(e.type);
  const pick = sel => { const e = sel && document.querySelector(sel); return e && vis(e) ? e : null; };
  const code = ins.find(e => e.autocomplete === 'one-time-code') || ins.find(e => texty(e) && /otp|totp|2fa|mfa|code|verif|token/i.test(e.name + ' ' + e.id + ' ' + (e.placeholder || '')));
  const pass = pick(h.pass) || ins.find(e => e.type === 'password');
  const user = pick(h.user) || ins.find(e => /username|email/.test(e.autocomplete)) || ins.find(e => e.type === 'email')
    || ins.find(e => texty(e) && e !== code && /user|mail|login|account|ident/i.test(e.name + ' ' + e.id))
    || (pass ? ins.filter(e => texty(e) && (e.compareDocumentPosition(pass) & 4)).pop() : null);
  const next = pick(h.next);
  user && user.setAttribute('data-bwl', 'u'); pass && pass.setAttribute('data-bwl', 'p');
  code && code.setAttribute('data-bwl', 'c'); next && next.setAttribute('data-bwl', 'n');
  const captcha = !!document.querySelector('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"],iframe[src*="arkoselabs"]');
  return { user: !!user, pass: !!pass, code: !!code && !pass, next: !!next, captcha, ready: document.readyState === 'complete' };
}`);

// focus a marked field and type into it, re-checking the site right before the value is sent
async function type(mark, text) {
  if (!siteOk(await href())) out({ ok: false, status: 'wrong-site', at: where(await href()), hint: 'page is not the saved site; nothing was typed' });
  const focused = await evaluate(`() => { const e = document.querySelector('[data-bwl=${mark}]'); if (!e) return false; e.focus(); e.select && e.select(); return document.activeElement === e; }`);
  if (!focused) return false;
  await send('Input.insertText', { text }, sid);
  return true;
}
const enter = async () => {
  for (const type of ['keyDown', 'keyUp'])
    await send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) }, sid);
};
// submit: the hint button, else Enter; if the page has not moved after 3 s, submit the field's form directly
async function advance(s) {
  if (s.next) return evaluate(() => document.querySelector('[data-bwl=n]').click());
  const before = await href();
  await enter();
  await sleep(3000);
  if (await href() === before) await evaluate(() => { const f = document.querySelector('[data-bwl=p],[data-bwl=c],[data-bwl=u]')?.form; f && (f.requestSubmit ? f.requestSubmit() : f.submit()); }).catch(() => {});
}

async function waitFor(test, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    try { const s = await scan(); if (test(s)) return s; } catch { /* page navigating */ }
  }
  return null;
}
// after submitting: what does the page look like now?
async function outcome() {
  const s = await waitFor(s => s.code || s.captcha || !s.pass, 12000) || await scan();
  const at = where(await href());
  if (s.captcha) return { ok: false, status: 'captcha', at, hint: 'site wants a CAPTCHA: ask Hlwan to do it once in the OpenClaw browser' };
  if (s.code) return { ok: true, status: 'needs-code', at, targetId, hint: 'ask Hlwan for the 2FA code, then: bwl.sh code <site> <code>' };
  if (s.pass) return { ok: false, status: 'failed', at, targetId, hint: 'still on the password page: wrong password, or the site needs a hint' };
  return { ok: true, status: 'logged-in', at, targetId };
}

if (job.mode === 'code') {
  const tabs = (await send('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && siteOk(t.url));
  if (!tabs.length) out({ ok: false, status: 'no-tab', hint: 'no open tab on that site; run login first' });
  let s;
  for (const t of tabs.reverse()) {                     // newest first; use the tab that is asking for a code
    targetId = t.targetId;
    sid = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    if ((s = await scan()).code) break;
  }
  if (!s.code) out({ ok: false, status: 'no-code-field', at: where(await href()) });
  await send('Page.bringToFront', {}, sid).catch(() => {});
  await type('c', job.code); await advance(s);
  out(await outcome());
}

// login: new tab on the saved url, or (here) the newest open tab on the saved site that shows a login form
if (job.here) {
  const tabs = (await send('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && siteOk(t.url)).reverse();
  for (const t of tabs) {
    targetId = t.targetId;
    sid = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const s = await scan().catch(() => ({}));
    if (s.user || s.pass) break;
    sid = null;
  }
  if (!sid) out({ ok: false, status: 'no-tab', hint: 'no open tab on that site with a login form; click the site\'s sign-in button first' });
} else {
  targetId = (await send('Target.createTarget', { url: job.url })).targetId;
  sid = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
}
await send('Page.bringToFront', {}, sid).catch(() => {});
let s = await waitFor(s => s.ready && (s.user || s.pass), 20000);
if (!s) out({ ok: false, status: 'no-form', at: where(await href()).slice(0, 200), targetId, hint: 'no login form found (already logged in? or add claw-user/claw-pass hints)' });
if (!siteOk(await href())) out({ ok: false, status: 'wrong-site', at: where(await href()), hint: 'login page redirected off the saved site; nothing was typed' });

if (s.user && job.username) await type('u', job.username);
if (!s.pass) {                                   // two-step: username, then the password page
  await advance(s);
  s = await waitFor(s => s.pass || s.captcha, 15000);
  if (!s || s.captcha) out({ ok: false, status: s ? 'captcha' : 'no-password-field', at: where(await href()), targetId });
}
if (!await type('p', job.password)) out({ ok: false, status: 'no-password-field', at: where(await href()), targetId });
job.password = '';
await advance(s);
out(await outcome());
