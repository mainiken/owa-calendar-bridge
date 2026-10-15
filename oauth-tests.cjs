const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname, 'owa-google-sync.user.js'), 'utf8');
const { clientId, token, serverHarness, FixtureDate } = require('./tests.cjs');
const scope = 'https://www.googleapis.com/auth/calendar.app.created';
const emailScope = 'https://www.googleapis.com/auth/userinfo.email';
const requestId = '11111111-2222-4333-8444-555555555555';
const pause = () => new Promise(resolve => setTimeout(resolve, 10));

function fixture(legacy = false) {
  const storage = new Map(), calls = [], events = new Map();
  const auth = { accessToken: 'synthetic-google-access', account: 'synthetic-account', email: 'tester@example.com', expires: Date.now() + 3600000 };
  const server = serverHarness();
  storage.set('owa-google-bridge-v1', { clientId, mode: legacy ? 'apps-script' : 'oauth', connection: legacy ? `https://script.google.com/macros/s/local_fixture/exec#${token}` : '', pastDays: 7, futureDays: 60, timezone: 'Europe/Moscow', accounts: {} });
  storage.set('owa-google-auth:owa.example.com', auth);
  const state = { creates: 0, failWrites: false, failList: false, failRead: false, responseCode: null, truncated: false };
  const context = { module: { exports: {} }, location: { hostname: 'owa.example.com' }, crypto: crypto.webcrypto, TextEncoder,
    URL, URLSearchParams, Intl, Date, setTimeout, clearTimeout, AbortController,
    GM_getValue: (key, fallback) => storage.get(key) ?? fallback, GM_setValue: (key, value) => storage.set(key, value), GM_deleteValue: key => storage.delete(key),
    GM_xmlhttpRequest(options) {
      calls.push(options);
      const url = new URL(options.url), body = options.data && JSON.parse(options.data);
      const respond = (status, data) => queueMicrotask(() => options.onload({ status, responseText: data === undefined ? '' : JSON.stringify(data) }));
      if (url.origin === 'https://script.google.com') {
        if (state.failWrites && body.op === 'upsert') return queueMicrotask(options.onerror);
        return respond(200, server.send(body));
      }
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
  const snapshot = { version: 1, clientId, source: 'owa.example.com', timezone: 'Europe/Moscow', windowStart: '2026-10-08T00:00:00.000Z', windowEnd: '2026-12-01T00:00:00.000Z', complete: true, events: [item] };
  return { api: context.module.exports, storage, auth, calls, state, events, item, snapshot, server };
}

async function test(name, callback) { await callback(); console.log('PASS ' + name); }

function sourceFixture() {
  const storage = new Map(), reads = [], state = { failDetails: false, items: Array.from({ length: 170 }, (_, i) => ({
    ItemId: { Id: `synthetic-source-${i}`, ChangeKey: 'revision-1' }, UID: `synthetic-uid-${i}`, Subject: `Meeting ${i}`,
    Start: '2026-10-15T10:00:00Z', End: '2026-10-15T11:00:00Z', CalendarItemType: 'Single', note: 'Original description'
  })) };
  const context = { module: { exports: {} }, location: { hostname: 'owa.example.com' }, crypto: crypto.webcrypto, TextEncoder,
    URL, URLSearchParams, Intl, Date: FixtureDate, setTimeout, clearTimeout, AbortController,
    document: { cookie: 'X-OWA-CANARY=SYNTHETIC_CANARY' },
    GM_getValue: (key, fallback) => key === 'owa-google-bridge-v1' ? { clientId } : storage.get(key) ?? fallback,
    GM_setValue: (key, value) => storage.set(key, value),
    fetch: async (url, options) => {
      const request = JSON.parse(options.body), find = url.includes('FindItem');
      if (!find && state.failDetails) return { ok: false, status: 403 };
      let response;
      if (find) {
        const from = Date.parse(request.Body.Paging.StartDate), to = Date.parse(request.Body.Paging.EndDate);
        const items = state.items.filter(item => Date.parse(item.End) > from && Date.parse(item.Start) < to).map(({ note, ...item }) => item);
        response = { ResponseCode: 'NoError', RootFolder: { IncludesLastItemInRange: true, Items: items } };
      } else {
        const ids = request.Body.ItemIds.map(item => item.Id); reads.push(...ids);
        response = { ResponseCode: 'NoError', Items: ids.map(id => { const item = state.items.find(item => item.ItemId.Id === id); return { ...item, Body: { BodyType: 'Text', Value: item.note } }; }) };
      }
      return { ok: true, status: 200, json: async () => ({ Body: { ResponseMessages: { Items: [response] } } }) };
    }
  };
  vm.runInNewContext(source, context);
  return { api: context.module.exports, storage, reads, state };
}

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
      assert.equal(w.document.getElementById('success-panel').hidden, true, 'Token storage is not yet successful account confirmation');
      channel.setAttribute('data-response', JSON.stringify({ type: 'owa-google-oauth:connected', requestId, email: 'tester@example.com' }));
      channel.dispatchEvent(new w.Event('owa-google-oauth:response', { bubbles: true }));
      assert.equal(w.document.getElementById('success-panel').hidden, false);
      assert.equal(w.document.getElementById('login-panel').hidden, true);
      assert.equal(w.document.getElementById('success-account').textContent, 'tester@example.com');
      await pause();
    } finally { dom.window.close(); }
  });
  await test('OWA login button opens hosted authorization and receives the account without losing old settings', async () => {
    const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://owa.example.com/owa/', runScripts: 'outside-only' });
    const storage = new Map();
    storage.set('owa-google-bridge-v1', { clientId, connection: '', futureDays: 60, accounts: { 'synthetic-account': { calendarId: 'saved-calendar' } } });
    let root, opened, closeAction, closes = 0;
    try {
      const w = dom.window; Object.defineProperty(w, 'crypto', { value: crypto.webcrypto }); w.TextEncoder = TextEncoder;
      const timeout = w.setTimeout.bind(w);
      w.setTimeout = (callback, delay, ...args) => { if (delay === 2500) { closeAction = callback; return 0; } return timeout(callback, delay, ...args); };
      w.GM_getValue = (k, d) => storage.get(k) ?? d; w.GM_setValue = (k, v) => storage.set(k, v); w.GM_deleteValue = k => storage.delete(k); w.GM_registerMenuCommand = () => {};
      w.GM_openInTab = (url, options) => {
        opened = { url, options }; const id = new URL(url).hash.slice(1), key = 'owa-google-auth:' + id;
        assert.equal(storage.get(key).status, 'pending');
        storage.set(key, { ...storage.get(key), status: 'complete', accessToken: 'synthetic-tab-access', tokenExpires: Date.now() + 600000 });
        return { closed: false, close() { closes++; assert.equal(storage.get('owa-google-auth:owa.example.com').account, 'synthetic-account'); } };
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
      assert.equal(new URL(opened.url).searchParams.get('v'), require('./package.json').version);
      assert.equal(root.getElementById('save').disabled, false);
      assert.ok(root.getElementById('account').textContent.includes('tester@example.com'));
      assert.equal(storage.get('owa-google-bridge-v1').accounts['synthetic-account'].calendarId, 'saved-calendar');
      const receipt = storage.get('owa-google-auth:' + new URL(opened.url).hash.slice(1));
      assert.equal(receipt.status, 'connected'); assert.equal(receipt.accessToken, undefined);
      assert.equal(root.getElementById('dialog').hasAttribute('open'), false);
      assert.equal(closes, 0); closeAction(); assert.equal(closes, 1);
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
      assert.equal(w.location.hash, ''); assert.equal(w.document.getElementById('success-panel').hidden, true);
      storage.set(key, { status: 'connected', email: 'tester@example.com', expires: Date.now() + 10000 });
      for (let i = 0; i < 100 && w.document.getElementById('success-panel').hidden; i++) await pause();
      assert.equal(w.document.getElementById('success-panel').hidden, false);
      const channel = w.document.getElementById('owa-google-auth-channel');
      assert.equal(channel.hasAttribute('data-command'), false); assert.equal(channel.hasAttribute('data-response'), false);
      assert.ok(!w.document.documentElement.outerHTML.includes('synthetic-isolated-token'));
    } finally { dom.window.close(); }
  });
  await test('Authorization HTML pins asset content hashes and visible release version', async () => {
    const version = require('./package.json').version;
    const dom = new JSDOM(fs.readFileSync(path.join(__dirname, 'connect.html'), 'utf8'));
    try {
      for (const [selector, attribute, name] of [['script[src^="connect.js"]', 'src', 'connect.js'], ['link[href^="connect.css"]', 'href', 'connect.css']]) {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
        assert.equal(dom.window.document.querySelector(selector).getAttribute(attribute), `${name}?build=${digest}`);
      }
      assert.equal(dom.window.document.getElementById('page-version').textContent, version);
      const index = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
      assert.ok(index.includes(`url=INSTALL.html?v=${version}`));
      assert.ok(index.includes(`href="INSTALL.html?v=${version}"`));
    } finally { dom.window.close(); }
  });
  await test('170 unchanged meetings require zero repeated detail reads and zero Google event writes', async () => {
    const input = sourceFixture(), target = fixture();
    const first = await input.api.collect(); assert.equal(first.events.length, 170); assert.equal(input.reads.length, 170);
    assert.equal((await target.api.syncOAuth(first, target.auth)).created, 170);
    input.reads.length = 0; const before = target.calls.length;
    const second = await input.api.collect(); assert.equal(input.reads.length, 0); assert.equal(second.events.length, 170);
    assert.equal((await target.api.syncOAuth(second, target.auth)).unchanged, 170);
    const repeatCalls = target.calls.slice(before); assert.equal(repeatCalls.length, 1); assert.equal(repeatCalls[0].method, 'GET');
    assert.ok(new URL(repeatCalls[0].url).searchParams.get('fields').includes('extendedProperties'));
    assert.ok(!new URL(repeatCalls[0].url).searchParams.get('fields').includes('description'));
    input.state.items[0].note = 'Updated call link https://call.example.com/changed';
    input.state.items[0].ItemId.ChangeKey = 'revision-2'; input.reads.length = 0;
    const changed = await input.api.collect(); assert.equal(input.reads.length, 1);
    assert.equal((await target.api.syncOAuth(changed, target.auth)).updated, 1);
    input.state.items.splice(1, 1); input.reads.length = 0;
    const cancelled = await input.api.collect(); assert.equal(input.reads.length, 0); assert.equal(cancelled.events.length, 169);
    assert.equal((await target.api.syncOAuth(cancelled, target.auth)).deleted, 1);
  });
  await test('Missing source revision re-reads details and failed reads cannot commit a new cache', async () => {
    const input = sourceFixture(); await input.api.collect();
    delete input.state.items[0].ItemId.ChangeKey; input.reads.length = 0;
    await input.api.collect(); assert.equal(input.reads.length, 1);
    input.state.items[0].note = 'Description changed without source revision'; input.reads.length = 0;
    const second = await input.api.collect(); assert.equal(input.reads.length, 1);
    assert.ok(second.events.some(item => item.description.includes('Description changed without source revision')));
    const before = JSON.stringify([...input.storage]); input.state.failDetails = true;
    await assert.rejects(input.api.collect(), /OWA отклонил/);
    assert.equal(JSON.stringify([...input.storage]), before);
  });
  await test('Apps Script skips acknowledged content while preserving cancellation keys and retrying failures', async () => {
    const f = fixture(true); assert.equal((await f.api.syncAppsScript(f.snapshot)).created, 1);
    let before = f.calls.length;
    assert.equal((await f.api.syncAppsScript(f.snapshot)).unchanged, 1);
    let repeated = f.calls.slice(before).map(call => JSON.parse(call.data));
    assert.equal(repeated.filter(item => item.op === 'upsert').length, 0); assert.equal(repeated[0].op, 'finalize'); assert.equal(repeated[0].keys.length, 1);
    f.state.failWrites = true;
    const changed = { ...f.snapshot, events: [{ ...f.item, title: 'Updated meeting' }] };
    await assert.rejects(f.api.syncAppsScript(changed));
    f.state.failWrites = false; before = f.calls.length;
    assert.equal((await f.api.syncAppsScript(changed)).updated, 1);
    repeated = f.calls.slice(before).map(call => JSON.parse(call.data)); assert.equal(repeated.filter(item => item.op === 'upsert').length, 1);
    const receipt = [...f.storage.entries()].find(([key]) => key.startsWith('owa-google-receipts:'))[1];
    receipt.items[f.item.key].at = 0; before = f.calls.length;
    await f.api.syncAppsScript(changed); assert.ok(f.calls.slice(before).some(call => JSON.parse(call.data).op === 'upsert'));
    assert.equal((await f.api.syncAppsScript({ ...changed, events: [] })).deleted, 1);
  });
  await test('Failed OWA confirmation cannot display a successful connection', async () => {
    const dom = new JSDOM(fs.readFileSync(path.join(__dirname, 'connect.html'), 'utf8'), { url: `https://mainiken.github.io/owa-calendar-bridge/connect.html#${requestId}`, runScripts: 'outside-only' });
    try {
      const w = dom.window, channel = w.document.getElementById('owa-google-auth-channel'); let callback;
      w.google = { accounts: { oauth2: { initTokenClient(options) { callback = options.callback; return { requestAccessToken() {} }; }, hasGrantedAllScopes: () => true } } };
      w.eval(fs.readFileSync(path.join(__dirname, 'connect.js'), 'utf8'));
      const send = (type, fields = {}) => { channel.setAttribute('data-response', JSON.stringify({ type, requestId, ...fields })); channel.dispatchEvent(new w.Event('owa-google-oauth:response', { bubbles: true })); };
      send('owa-google-oauth:ready'); w.document.getElementById('login').click();
      callback({ access_token: 'synthetic-failed-login-token', expires_in: 3600, scope });
      send('owa-google-oauth:saved'); send('owa-google-oauth:failed', { message: 'Account verification failed' });
      assert.equal(w.document.getElementById('success-panel').hidden, true);
      assert.equal(w.document.getElementById('status').textContent, 'Account verification failed');
    } finally { dom.window.close(); }
  });
  console.log('\n17 OAuth/incremental checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
