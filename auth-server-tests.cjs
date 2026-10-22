'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createService } = require('./auth-server.cjs');
const calendarScope = 'https://www.googleapis.com/auth/calendar.app.created';
const emailScope = 'https://www.googleapis.com/auth/userinfo.email';
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'owa-auth-test-'));
  const state = { time: Date.now(), calls: [], failure: null, refresh: 0, missingRefresh: false, scope: `${calendarScope} ${emailScope}`, wait: null };
  const options = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', encryptionKey: crypto.randomBytes(32).toString('base64'), directory, now: () => state.time,
    async fetchImpl(url, init) {
      state.calls.push({ url, init });
      if (url.endsWith('/userinfo')) return json({ sub: 'synthetic-account', email: 'tester@example.com' });
      assert.equal(url, 'https://oauth2.googleapis.com/token');
      assert.equal(init.body.get('client_secret'), 'synthetic-secret');
      if (init.body.get('grant_type') === 'refresh_token') {
        state.refresh++;
        assert.equal(init.body.get('refresh_token'), 'synthetic-refresh-secret');
        if (state.wait) await state.wait;
        if (state.failure) return json({ error: state.failure }, state.failure === 'invalid_grant' ? 400 : 503);
        return json({ access_token: 'renewed-access-' + state.refresh, expires_in: 3600 });
      }
      assert.equal(init.body.get('redirect_uri'), 'https://mainiken.github.io');
      return json({ access_token: 'initial-access', refresh_token: state.missingRefresh ? undefined : 'synthetic-refresh-secret', expires_in: 3600, scope: state.scope });
    }
  };
  return { service: createService(options), state, options, directory, close: () => fs.rm(directory, { recursive: true, force: true }) };
}
async function test(name, action) { await action(); console.log('PASS ' + name); }
(async () => {
  await test('Offline grant survives service restart and expiry without another Google login', async () => {
    const f = await fixture();
    try {
      const login = await f.service.exchange('synthetic-auth-code');
      assert.match(login.sessionToken, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(login.refreshToken, undefined);
      const files = await fs.readdir(f.directory); assert.equal(files.length, 1);
      const stored = await fs.readFile(path.join(f.directory, files[0]));
      assert.ok(!stored.includes(Buffer.from('synthetic-refresh-secret'))); assert.ok(!stored.includes(Buffer.from(login.sessionToken)));
      assert.equal((await f.service.refresh(login.sessionToken)).accessToken, 'initial-access'); assert.equal(f.state.refresh, 0);
      f.state.time += 3600000;
      const restarted = createService(f.options);
      const results = await Promise.all(Array.from({ length: 5 }, () => restarted.refresh(login.sessionToken)));
      assert.equal(f.state.refresh, 1); assert.ok(results.every(result => result.accessToken === 'renewed-access-1'));
      assert.equal(f.state.calls.filter(call => call.init.body?.get('grant_type') === 'authorization_code').length, 1);
      f.state.time += 3600000;
      assert.equal((await restarted.refresh(login.sessionToken)).accessToken, 'renewed-access-2');
    } finally { await f.close(); }
  });
  await test('Transient Google failures preserve grant; revocation removes only that session', async () => {
    const f = await fixture();
    try {
      const a = await f.service.exchange('synthetic-auth-code-a'), b = await f.service.exchange('synthetic-auth-code-b');
      f.state.time += 3600000; f.state.failure = 'temporarily_unavailable';
      await assert.rejects(f.service.refresh(a.sessionToken), error => error.status === 503);
      assert.equal((await fs.readdir(f.directory)).length, 2);
      f.state.failure = null; assert.ok((await f.service.refresh(a.sessionToken)).accessToken);
      f.state.failure = 'invalid_grant';
      await assert.rejects(f.service.refresh(b.sessionToken), error => error.status === 401);
      assert.equal((await fs.readdir(f.directory)).length, 1);
      assert.ok((await f.service.refresh(a.sessionToken)).accessToken);
    } finally { await f.close(); }
  });
  await test('Disconnect cannot race refresh into recreating an offline grant', async () => {
    const f = await fixture();
    try {
      const login = await f.service.exchange('synthetic-auth-code'); f.state.time += 3600000;
      let release; f.state.wait = new Promise(resolve => { release = resolve; });
      const pending = f.service.refresh(login.sessionToken);
      const removal = f.service.disconnect(login.sessionToken);
      release(); await pending; await removal;
      await assert.rejects(f.service.refresh(login.sessionToken), error => error.status === 401);
      assert.deepEqual(await fs.readdir(f.directory), []);
    } finally { await f.close(); }
  });
  await test('Missing offline grant or scopes cannot be presented as a permanent login', async () => {
    const f = await fixture();
    try {
      f.state.missingRefresh = true;
      await assert.rejects(f.service.exchange('synthetic-auth-code'), error => error.status === 409);
      f.state.missingRefresh = false; f.state.scope = emailScope;
      await assert.rejects(f.service.exchange('synthetic-auth-code'), error => error.status === 400);
      await assert.rejects(f.service.refresh('../invalid'), error => error.status === 401);
      assert.deepEqual(await fs.readdir(f.directory), []);
    } finally { await f.close(); }
  });
  await test('HTTP rejects cross-origin exchange and cookie-only access, redacts secrets', async () => {
    const f = await fixture(), server = http.createServer(f.service.handler);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/owa-calendar-auth`;
    const headers = { 'Content-Type': 'application/json', Origin: 'https://mainiken.github.io', 'X-Requested-With': 'OWACalendarBridge' };
    try {
      assert.equal((await fetch(base + '/exchange', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: JSON.stringify({ code: 'synthetic-auth-code' }) })).status, 403);
      assert.equal(f.state.calls.length, 0);
      assert.equal((await fetch(base + '/token', { method: 'POST', headers, body: '{}' })).status, 401);
      const response = await fetch(base + '/exchange', { method: 'POST', headers, body: JSON.stringify({ code: 'synthetic-auth-code' }) });
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const result = await response.json(); assert.ok(result.sessionToken); assert.equal(result.refreshToken, undefined);
      assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
      const authenticated = { ...headers, Authorization: `Bearer ${result.sessionToken}` };
      assert.equal((await fetch(base + '/token', { method: 'POST', headers: authenticated, body: '{}' })).status, 200);
      assert.equal((await fetch(base + '/disconnect', { method: 'POST', headers: authenticated, body: '{}' })).status, 200);
      assert.equal((await fetch(base + '/token', { method: 'POST', headers: authenticated, body: '{}' })).status, 401);
    } finally { await new Promise(resolve => server.close(resolve)); await f.close(); }
  });
  await test('Userscript renews expired access once, retries API 401, retains login after outage', async () => {
    const storage = new Map(), requests = [];
    const authKey = 'owa-google-auth:owa.example.com';
    const auth = { sessionToken: 's'.repeat(43), accessToken: 'old-access', expires: 0, account: 'synthetic-account', email: 'tester@example.com' };
    storage.set(authKey, auth);
    let failure = 0, refreshes = 0, rejectApiOnce = true;
    const context = { module: { exports: {} }, location: { hostname: 'owa.example.com' }, crypto: crypto.webcrypto, Date, URL, URLSearchParams, TextEncoder, setTimeout, clearTimeout,
      GM_getValue: (key, fallback) => storage.get(key) ?? fallback, GM_setValue: (key, value) => storage.set(key, value), GM_deleteValue: key => storage.delete(key),
      GM_xmlhttpRequest(options) {
        requests.push(options);
        if (options.url.includes('/owa-calendar-auth/')) {
          refreshes++;
          queueMicrotask(() => options.onload({ status: failure || 200, responseText: JSON.stringify(failure ? { error: 'reauthorize' } : { account: auth.account, email: auth.email, accessToken: 'new-access-' + refreshes, expires: Date.now() + 3000000 }) }));
        } else {
          const code = rejectApiOnce ? 401 : 200; rejectApiOnce = false;
          queueMicrotask(() => options.onload({ status: code, responseText: '{}' }));
        }
      }
    };
    vm.runInNewContext(await fs.readFile(path.join(__dirname, 'owa-google-sync.user.js'), 'utf8'), context);
    const api = context.module.exports;
    await Promise.all([api.ensureAuth(), api.ensureAuth()]); assert.equal(refreshes, 1);
    await api.googleApi('/calendar/v3/calendars'); assert.equal(refreshes, 2);
    assert.equal(storage.get(authKey).sessionToken, auth.sessionToken);
    assert.ok(requests.every(request => !request.url.includes(auth.sessionToken)));
    storage.get(authKey).expires = 0; failure = 503;
    await assert.rejects(api.ensureAuth(), /позже/); assert.ok(storage.get(authKey).sessionToken);
    failure = 401;
    await assert.rejects(api.ensureAuth(), /отозвал/); assert.equal(storage.has(authKey), false);
  });
  console.log('\n6 persistent authorization checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
