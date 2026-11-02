// Fake login site for tests/leak-test.sh. Records what was submitted to <record-file>.
//   /one     username + password on one page        /two  username, then password page
//   /otp     password page, then a 2FA code page    /away redirects to another host (localhost) with a login form
import http from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';
const [portFile, record] = process.argv.slice(2);
const form = (action, fields) => `<!doctype html><form method=post action="${action}">${fields}<button>Go</button></form>`;
const U = '<input name=username autocomplete=username>', P = '<input name=password type=password>';
const routes = {
  '/one': () => form('/done', U + P),
  '/two': () => form('/two-pass', U),
  '/otp': () => form('/otp-code', U + P),
};
http.createServer((req, res) => {
  let body = ''; req.on('data', c => body += c); req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (body) appendFileSync(record, `${u.pathname} ${body}\n`);
    const html = t => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(t); };
    if (routes[u.pathname]) return html(routes[u.pathname]());
    if (u.pathname === '/two-pass') return html(form('/done', P));
    if (u.pathname === '/otp-code') return html(form('/done', '<input name=code autocomplete=one-time-code>'));
    if (u.pathname === '/error') return html('<title>Error</title><p>\n  システムエラーが発生いたしました。');
    if (u.pathname === '/away') { res.writeHead(302, { location: `http://localhost:${req.socket.localPort}/one` }); return res.end(); }
    html('<h1>Welcome</h1>');
  });
}).listen(0, '127.0.0.1', function () { writeFileSync(portFile, String(this.address().port)); });
