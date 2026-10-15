const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, 'owa-google-sync.user.js'), 'utf8');
const { clientId } = require('./tests.cjs');
const scope = 'https://www.googleapis.com/auth/calendar.app.created';
const emailScope = 'https://www.googleapis.com/auth/userinfo.email';
const requestId = '11111111-2222-4333-8444-555555555555';
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

function fixture() {
  const storage = new Map(), calls = [], events = new Map();
  const auth = { accessToken: 'synthetic-google-access', account: 'synthetic-account', email: 'tester@example.com', expires: Date.now() + 3600000 };
  storage.set('owa-google-bridge-v1', { clientId, mode: 'oauth', pastDays: 7, futureDays: 60, timezone: 'Europe/Moscow', accounts: {} });
  storage.set('owa-google-auth:owa.example.com', auth);
  const state = { creates: 0, failWrites: false, failList: false, failRead: false, responseCode: null, truncated: false };
  const context = { module: { exports: {} }, location: { hostname: 'owa.example.com' }, crypto: crypto.webcrypto, TextEncoder,
    URL, URLSearchParams, Intl, Date, setTimeout, clearTimeout, AbortController,
    GM_getValue: (key, fallback) => storage.get(key) ?? fallback, GM_setValue: (key, value) => storage.set(key, value), GM_deleteValue: key => storage.delete(key),
    GM_xmlhttpRequest(options) {
      calls.push(options);
      const url = new URL(options.url), body = options.data && JSON.parse(options.data);
      const respond = (status, data) => queueMicrotask(() => options.onload({ status, responseText: data === undefined ? '' : JSON.stringify(data) }));
      if (state.responseCode) return respond(state.responseCode, { error: { message: 'must not expose synthetic credential', errors: [{ reason: 'insufficientPermissions' }] } });
      if (url.pathname === '/oauth2/v3/userinfo') return respond(200, { sub: auth.account, email: auth.email });
      if (url.pathname === '/calendar/v3/calendars') { state.creates++; return respond(200, { id: 'dedicated@example.com' }); }
      assert.ok(url.pathname.startsWith('/calendar/v3/calendars/dedicated%40example.com/events'));
      if (options.method === 'GET' && url.pathname.endsWith('/events')) {
        if (state.failList) return respond(200, {});
        const items = [...events.values()].filter(event => Date.parse(event.end.dateTime || event.end.date) > Date.parse(url.searchParams.get('timeMin')) && Date.parse(event.start.dateTime || event.start.date) < Date.parse(url.searchParams.get('timeMax')));
        return respond(200, { items, ...(state.truncated ? { nextPageToken: 'same-page' } : {}) });
      }
      const id = decodeURIComponent(url.pathname.split('/').pop());
      if (options.method === 'GET') return respond(state.failRead ? 503 : events.has(id) ? 200 : 404, events.get(id) || {});
      if (state.failWrites && options.method !== 'DELETE') return respond(503, {});
      if (options.method === 'POST') {
        assert.match(body.id, /^[a-v0-9]{5,1024}$/);
        assert.equal(url.searchParams.get('sendUpdates'), 'none');
        assert.equal(body.attendees, undefined);
        if (events.has(body.id)) return respond(409, {});
        events.set(body.id, { ...body }); return respond(200, body);
      }
      if (options.method === 'PUT') { events.set(id, { ...body, id }); return respond(200, events.get(id)); }
      if (options.method === 'DELETE') { events.delete(id); return respond(204); }
      throw new Error('Unexpected request');
    }
  };
  vm.runInNewContext(source, context);
  const item = { key: 'b'.repeat(64), title: 'Synthetic meeting', start: '2026-10-15T10:00:00.000Z', end: '2026-10-15T11:00:00.000Z', allDay: false, description: 'Join https://call.example.com/test', location: '' };
  const snapshot = { clientId, source: 'owa.example.com', timezone: 'Europe/Moscow', windowStart: '2026-10-08T00:00:00.000Z', windowEnd: '2026-12-01T00:00:00.000Z', complete: true, events: [item] };
  return { api: context.module.exports, storage, auth, calls, state, events, item, snapshot };
}

async function test(name, callback) { await callback(); console.log('PASS ' + name); }

(async () => {
  await test('OAuth creates a dedicated calendar once and repeats without duplicates', async () => {
    const f = fixture();
    assert.equal((await f.api.syncOAuth(f.snapshot, f.auth)).created, 1);
    assert.equal((await f.api.syncOAuth(f.snapshot, f.auth)).unchanged, 1);
    assert.equal(f.events.size, 1); assert.equal(f.state.creates, 1);
    for (const call of f.calls) { assert.equal(new URL(call.url).origin, 'https://www.googleapis.com'); assert.equal(call.anonymous, true); assert.equal(call.headers.Authorization, `Bearer ${f.auth.accessToken}`); assert.ok(!call.url.includes(f.auth.accessToken)); }
  });
  await test('OAuth moved event outside the window is recovered by deterministic ID', async () => {
    const f = fixture(); await f.api.syncOAuth(f.snapshot, f.auth);
    const event = [...f.events.values()][0]; event.start.dateTime = '2027-01-10T10:00:00Z'; event.end.dateTime = '2027-01-10T11:00:00Z'; event.extendedProperties.private.digest = 'changed';
    assert.equal((await f.api.syncOAuth(f.snapshot, f.auth)).updated, 1); assert.equal(f.events.size, 1);
    assert.equal([...f.events.values()][0].start.dateTime, f.item.start);
  });
  await test('OAuth handles all-day dates and timed/all-day conversion', async () => {
    const f = fixture(); await f.api.syncOAuth(f.snapshot, f.auth);
    f.item.allDay = true; f.item.startDate = '2026-10-15'; f.item.endDate = '2026-10-16';
    assert.equal((await f.api.syncOAuth(f.snapshot, f.auth)).updated, 1);
    assert.equal([...f.events.values()][0].start.date, '2026-10-15');
    f.item.allDay = false; assert.equal((await f.api.syncOAuth(f.snapshot, f.auth)).updated, 1);
    assert.equal([...f.events.values()][0].start.dateTime, f.item.start);
  });
  await test('OAuth incomplete source cannot delete; complete cancellation deletes only its copies', async () => {
    const f = fixture(); await f.api.syncOAuth(f.snapshot, f.auth);
    assert.equal((await f.api.syncOAuth({ ...f.snapshot, events: [], complete: false }, f.auth)).deleted, 0); assert.equal(f.events.size, 1);
    assert.equal((await f.api.syncOAuth({ ...f.snapshot, events: [] }, f.auth)).deleted, 1); assert.equal(f.events.size, 0);
  });
  await test('OAuth failed write or malformed/paginated listing blocks cleanup', async () => {
    const f = fixture(); await f.api.syncOAuth(f.snapshot, f.auth);
    const changed = { ...f.item, key: 'c'.repeat(64) }; f.state.failWrites = true;
    await assert.rejects(f.api.syncOAuth({ ...f.snapshot, events: [changed] }, f.auth));
    assert.equal(f.events.size, 1); assert.equal(f.calls.filter(c => c.method === 'DELETE').length, 0);
    f.state.failWrites = false; f.state.failList = true;
    await assert.rejects(f.api.syncOAuth({ ...f.snapshot, events: [] }, f.auth));
    f.state.failList = false; f.state.truncated = true;
    await assert.rejects(f.api.syncOAuth({ ...f.snapshot, events: [] }, f.auth));
    assert.equal(f.events.size, 1);
  });
  await test('OAuth rejects wrong ownership, duplicate source keys and recurring copies', async () => {
    const f = fixture(); await f.api.syncOAuth(f.snapshot, f.auth);
    const event = [...f.events.values()][0]; event.extendedProperties.private.bridge = 'someone-else';
    await assert.rejects(f.api.syncOAuth({ ...f.snapshot, events: [] }, f.auth)); assert.equal(f.events.size, 1);
    event.extendedProperties.private.bridge = 'owa-google-oauth-v1'; event.recurrence = ['RRULE:FREQ=DAILY'];
    await assert.rejects(f.api.syncOAuth({ ...f.snapshot, events: [] }, f.auth)); assert.equal(f.events.size, 1);
    delete event.recurrence; f.events.set('duplicate', { ...event, id: 'duplicate' });
    await assert.rejects(f.api.syncOAuth({ ...f.snapshot, events: [] }, f.auth)); assert.equal(f.events.size, 2);
  });
  await test('OAuth API errors redact remote payloads and 401 clears local authorization', async () => {
    const f = fixture(); f.state.responseCode = 401;
    await assert.rejects(f.api.googleApi('/calendar/v3/calendars', { credential: f.auth }), /Вход Google истёк/);
    assert.equal(f.storage.has('owa-google-auth:owa.example.com'), false);
    f.state.responseCode = 403;
    await assert.rejects(f.api.googleApi('/calendar/v3/calendars', { credential: f.auth }), error => error.message.includes('calendar.app.created') && !error.message.includes('must not expose'));
    assert.throws(() => f.api.googleApi('/untrusted', { credential: f.auth }));
  });
  await test('OAuth expiry removes stale token without changing the saved calendar', async () => {
    const f = fixture(); await f.api.syncOAuth(f.snapshot, f.auth); f.auth.expires = 0;
    assert.throws(() => f.api.currentAuth(), /обновить вход/);
    assert.equal(f.storage.has('owa-google-auth:owa.example.com'), false);
    assert.equal(f.storage.get('owa-google-bridge-v1').accounts[f.auth.account].calendarId, 'dedicated@example.com');
  });
  await test('DOM OAuth bridge rejects unsolicited, expired and wrong-nonce requests', async () => {
    const storage = new Map(), key = 'owa-google-auth:' + requestId;
    const dom = new JSDOM('<!doctype html><body><div id="owa-google-auth-channel" hidden></div></body>', { url: `https://mainiken.github.io/owa-calendar-bridge/connect.html#${requestId}`, runScripts: 'outside-only' });
    try {
      const w = dom.window; w.GM_getValue = (k, d) => storage.get(k) ?? d; w.GM_setValue = (k, v) => storage.set(k, v);
      w.eval(source);
      const data = { type: 'owa-google-oauth:token', requestId, accessToken: 'synthetic-access-token', expiresIn: 3600, scope };
      const channel = w.document.getElementById('owa-google-auth-channel');
      const send = (overrides = {}) => { channel.setAttribute('data-command', JSON.stringify({ ...data, ...overrides })); channel.dispatchEvent(new w.Event('owa-google-oauth:request', { bubbles: true })); };
      send(); assert.equal(storage.size, 0);
      storage.set(key, { status: 'pending', expires: Date.now() - 1 }); send(); assert.equal(storage.get(key).status, 'pending');
      storage.set(key, { status: 'pending', expires: Date.now() + 10000 }); send({ requestId: crypto.randomUUID() }); send({ scope: 'unrelated' });
      assert.equal(storage.get(key).status, 'pending');
      send(); assert.equal(storage.get(key).status, 'complete'); assert.equal(storage.get(key).accessToken, data.accessToken); assert.equal(channel.hasAttribute('data-command'), false);
      send({ accessToken: 'different-synthetic-token' }); assert.equal(storage.get(key).accessToken, data.accessToken);
    } finally { dom.window.close(); }
  });
  await test('Hosted OAuth page requests only narrow scopes and hands token through nonce bridge', async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(__dirname, 'connect.html'), 'utf8'), { url: `https://mainiken.github.io/owa-calendar-bridge/connect.html#${requestId}`, runScripts: 'outside-only' });
    try {
      const w = dom.window, messages = []; let settings, requested;
      const channel = w.document.getElementById('owa-google-auth-channel');
      w.document.addEventListener('owa-google-oauth:request', () => { messages.push(JSON.parse(channel.getAttribute('data-command'))); });
      w.google = { accounts: { oauth2: { initTokenClient(options) { settings = options; return { requestAccessToken(options) { requested = options; } }; }, hasGrantedAllScopes: () => true } } };
      w.eval(fs.readFileSync(path.join(__dirname, 'connect.js'), 'utf8'));
      const send = type => { channel.setAttribute('data-response', JSON.stringify({ type, requestId })); channel.dispatchEvent(new w.Event('owa-google-oauth:response', { bubbles: true })); };
      assert.equal(w.document.getElementById('login').disabled, true); send('owa-google-oauth:ready');
      w.document.getElementById('login').click();
      assert.ok(settings.scope.includes(scope)); assert.ok(settings.scope.includes(emailScope)); assert.ok(!settings.scope.includes('auth/calendar ')); assert.equal(settings.client_secret, undefined);
      assert.equal(requested.prompt, 'select_account');
      settings.callback({ access_token: 'synthetic-token-response', expires_in: 3600, scope });
      const delivered = messages.find(item => item.type === 'owa-google-oauth:token');
      assert.equal(delivered.requestId, requestId); assert.equal(channel.hasAttribute('data-command'), false);
      assert.ok(!w.location.href.includes('synthetic-token')); send('owa-google-oauth:saved');
      assert.equal(w.location.hash, ''); assert.equal(w.document.getElementById('login').disabled, true);
      assert.ok(w.document.getElementById('status').textContent.includes('Вернись в OWA'));
      await pause();
    } finally { dom.window.close(); }
  });
  await test('OWA login button opens hosted authorization and receives the account without losing old settings', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://owa.example.com/owa/', runScripts: 'outside-only' });
    const storage = new Map();
    storage.set('owa-google-bridge-v1', { clientId, connection: '', futureDays: 60, accounts: { 'synthetic-account': { calendarId: 'saved-calendar' } } });
    let root, opened;
    try {
      const w = dom.window; Object.defineProperty(w, 'crypto', { value: crypto.webcrypto }); w.TextEncoder = TextEncoder;
      w.GM_getValue = (k, d) => storage.get(k) ?? d; w.GM_setValue = (k, v) => storage.set(k, v); w.GM_deleteValue = k => storage.delete(k); w.GM_registerMenuCommand = () => {};
      w.GM_openInTab = (url, options) => {
        opened = { url, options }; const id = new URL(url).hash.slice(1), key = 'owa-google-auth:' + id;
        assert.equal(storage.get(key).status, 'pending');
        storage.set(key, { ...storage.get(key), status: 'complete', accessToken: 'synthetic-tab-access', tokenExpires: Date.now() + 600000 });
        return { closed: false };
      };
      w.GM_xmlhttpRequest = options => {
        assert.equal(options.url, 'https://www.googleapis.com/oauth2/v3/userinfo');
        queueMicrotask(() => options.onload({ status: 200, responseText: JSON.stringify({ sub: 'synthetic-account', email: 'tester@example.com' }) }));
      };
      const attach = w.Element.prototype.attachShadow;
      w.Element.prototype.attachShadow = function(options) { root = attach.call(this, options); return root; };
      w.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
      w.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); };
      w.eval(source);
      root.getElementById('settings').click(); assert.equal(root.getElementById('mode').value, 'oauth');
      root.getElementById('oauth-login').click(); assert.equal(root.getElementById('save').disabled, true);
      for (let i = 0; i < 100 && root.getElementById('save').disabled; i++) await pause();
      assert.equal(new URL(opened.url).pathname, '/owa-calendar-bridge/connect.html'); assert.equal(opened.options.active, true);
      assert.equal(root.getElementById('save').disabled, false);
      assert.ok(root.getElementById('account').textContent.includes('tester@example.com'));
      assert.equal(storage.get('owa-google-bridge-v1').accounts['synthetic-account'].calendarId, 'saved-calendar');
      assert.ok(![...storage.keys()].some(key => key.startsWith('owa-google-auth:') && key.endsWith(new URL(opened.url).hash.slice(1))));
      root.getElementById('oauth-disconnect').click(); assert.equal(storage.has('owa-google-auth:owa.example.com'), false);
      assert.equal(storage.get('owa-google-bridge-v1').accounts['synthetic-account'].calendarId, 'saved-calendar');
    } finally { dom.window.close(); }
  });
  await test('Real hosted page handshake crosses isolated JS worlds through shared DOM', async () => {
    const storage = new Map(), key = 'owa-google-auth:' + requestId;
    storage.set(key, { status: 'pending', expires: Date.now() + 10000 });
    const dom = new JSDOM(fs.readFileSync(path.join(__dirname, 'connect.html'), 'utf8'), { url: `https://mainiken.github.io/owa-calendar-bridge/connect.html#${requestId}`, runScripts: 'outside-only' });
    try {
      const w = dom.window; let tokenOptions;
      w.google = { accounts: { oauth2: { initTokenClient(options) { tokenOptions = options; return { requestAccessToken() { options.callback({ access_token: 'synthetic-isolated-token', expires_in: 3600, scope: `${scope} ${emailScope}` }); } }; }, hasGrantedAllScopes: () => true } } };
      w.postMessage = () => { throw new Error('Window message channel must not be used'); };
      // Distinct JS globals and window identity, exactly one shared browser DOM.
      const isolated = { location: w.location, document: w.document, Event: w.Event, window: {},
        GM_getValue: (k, d) => storage.get(k) ?? d, GM_setValue: (k, v) => storage.set(k, v), Date };
      w.eval(fs.readFileSync(path.join(__dirname, 'connect.js'), 'utf8'));
      vm.runInNewContext(source, isolated);
      const button = w.document.getElementById('login');
      for (let i = 0; i < 100 && button.disabled; i++) await pause();
      assert.equal(button.disabled, false, w.document.getElementById('status').textContent);
      button.click(); assert.ok(tokenOptions);
      assert.equal(storage.get(key).status, 'complete'); assert.equal(storage.get(key).accessToken, 'synthetic-isolated-token');
      assert.equal(w.location.hash, ''); assert.ok(w.document.getElementById('status').textContent.includes('Вернись в OWA'));
      const channel = w.document.getElementById('owa-google-auth-channel');
      assert.equal(channel.hasAttribute('data-command'), false); assert.equal(channel.hasAttribute('data-response'), false);
      assert.ok(!w.document.documentElement.outerHTML.includes('synthetic-isolated-token'));
    } finally { dom.window.close(); }
  });
  console.log('\n12 OAuth checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
