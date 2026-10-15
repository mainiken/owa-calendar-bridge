// ==UserScript==
// @name         OWA → Google: мой календарь
// @namespace    local.calendar-bridge
// @version      1.4.0
// @description  Ручная синхронизация встреч из открытого OWA в отдельный Google Календарь.
// @match        https://*/owa/*
// @match        https://mainiken.github.io/owa-calendar-bridge/connect.html*
// @exclude      https://*/owa/calendar/*
// @run-at       document-idle
// @sandbox      DOM
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @connect      www.googleapis.com
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = 1;
  const STORAGE = 'owa-google-bridge-v1';
  const AUTH_PAGE = 'https://mainiken.github.io/owa-calendar-bridge/connect.html?v=1.4.0';
  const AUTH_ORIGIN = 'https://mainiken.github.io';
  const AUTH_PREFIX = 'owa-google-auth:';
  const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
  if (location.origin === AUTH_ORIGIN && location.pathname === '/owa-calendar-bridge/connect.html') {
    mountAuthBridge();
    return;
  }
  const SOURCE = location.hostname.toLowerCase();
  const DAY = 86400000;
  const TYPE = name => ({ __type: `${name}:#Exchange` });
  let config = loadConfig();
  let busy = false;
  let lastSnapshot = null;
  let ui;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const later = (fn, ms) => { const timer = setTimeout(fn, ms); timer?.unref?.(); return timer; };

  function loadConfig() {
    const saved = GM_getValue(STORAGE, null);
    const next = Object.assign({ clientId: crypto.randomUUID(), connection: '', pastDays: 7, futureDays: 60, timezone: 'Europe/Moscow', accounts: {} }, saved || {});
    next.mode ||= next.connection ? 'apps-script' : 'oauth';
    return next;
  }

  function saveConfig(next) {
    config = next;
    GM_setValue(STORAGE, config);
  }

  // A single userscript shares GM storage between its OWA and authorization tabs.
  // The nonce has no account/token data. No opener relationship is required.
  function mountAuthBridge() {
    const requestId = location.hash.slice(1);
    if (!/^[a-f0-9-]{36}$/i.test(requestId)) return;
    const key = AUTH_PREFIX + requestId;
    let completed = false;
    // DOM strings cross extension isolated worlds without sharing JS objects or
    // relying on MessageEvent.source, which may be null/wrapped in extensions.
    document.addEventListener('owa-google-oauth:request', () => {
      const channel = document.getElementById('owa-google-auth-channel');
      if (!channel) return;
      let data;
      try { data = JSON.parse(channel.getAttribute('data-command') || 'null'); } catch { return; }
      channel.removeAttribute('data-command');
      if (!data || data.requestId !== requestId) return;
      const reply = (type, extra = {}) => {
        channel.setAttribute('data-response', JSON.stringify({ type, requestId, version: '1.4.0', ...extra }));
        channel.dispatchEvent(new Event('owa-google-oauth:response', { bubbles: true }));
      };
      const pending = GM_getValue(key, null);
      if (data.type === 'owa-google-oauth:status' && pending?.expires > Date.now()) {
        if (pending.status === 'connected') reply('owa-google-oauth:connected', { email: pending.email });
        else if (pending.status === 'failed') reply('owa-google-oauth:failed', { message: pending.message });
        return;
      }
      if (completed) return;
      if (!pending || pending.status !== 'pending' || pending.expires <= Date.now()) {
        reply('owa-google-oauth:expired'); return;
      }
      if (data.type === 'owa-google-oauth:hello') {
        reply('owa-google-oauth:ready');
      } else if (data.type === 'owa-google-oauth:token') {
        const { accessToken, expiresIn, scope } = data;
        if (typeof accessToken !== 'string' || accessToken.length < 10 || accessToken.length > 4096 || /\s/.test(accessToken)) return;
        if (!Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 86400 || typeof scope !== 'string' || !scope.split(' ').includes(CALENDAR_SCOPE)) return;
        completed = true;
        GM_setValue(key, { ...pending, status: 'complete', accessToken, tokenExpires: Date.now() + expiresIn * 1000 - 30000 });
        reply('owa-google-oauth:saved');
      }
    });
  }

  function authKey() { return AUTH_PREFIX + SOURCE; }

  function currentAuth() {
    const auth = GM_getValue(authKey(), null);
    if (!auth?.accessToken || auth.expires <= Date.now()) {
      if (auth) GM_deleteValue(authKey());
      throw new Error('Нужно обновить вход Google. Нажми «Войти через Google» в настройках и затем повтори синхронизацию.');
    }
    return auth;
  }

  async function connectGoogle() {
    if (busy) return;
    const requestId = crypto.randomUUID(), key = AUTH_PREFIX + requestId;
    GM_setValue(key, { status: 'pending', expires: Date.now() + 5 * 60000 });
    setBusy(true);
    ui.dialogError.textContent = 'В новой вкладке нажми «Войти через Google», выбери аккаунт и разреши доступ.';
    let receipt = false;
    try {
      // Open synchronously from the user gesture, before any await.
      const authTab = GM_openInTab(`${AUTH_PAGE}#${requestId}`, { active: true, insert: true });
      let result;
      for (let i = 0; i < 600; i++) {
        await sleep(500);
        result = GM_getValue(key, null);
        if (result?.status === 'complete') break;
        if (authTab?.closed) throw new Error('Вкладка входа закрыта. Нажми «Войти через Google», чтобы повторить.');
      }
      if (result?.status !== 'complete' || result.tokenExpires <= Date.now()) throw new Error('Вход не завершён за 5 минут. Нажми «Войти через Google», чтобы повторить.');
      const credential = { accessToken: result.accessToken, expires: result.tokenExpires };
      const account = await googleApi('/oauth2/v3/userinfo', { credential });
      if (typeof account.sub !== 'string' || !account.sub || typeof account.email !== 'string') throw new Error('Google не вернул аккаунт. Разреши доступ к адресу почты при входе.');
      credential.account = account.sub;
      credential.email = account.email;
      GM_setValue(authKey(), credential);
      saveConfig({ ...config, mode: 'oauth', futureDays: Number(ui.future.value) });
      ui.mode.value = 'oauth';
      ui.dialogError.textContent = '';
      updateAccountLabel();
      ui.dialog.close();
      status('Google подключён. Нажми «Синхронизировать».');
      GM_setValue(key, { status: 'connected', email: account.email, expires: Date.now() + 60000 });
      receipt = true;
      later(() => { try { authTab?.close?.(); } catch {} }, 2500);
    } catch (error) {
      ui.dialogError.textContent = error.message;
      GM_setValue(key, { status: 'failed', message: error.message, expires: Date.now() + 60000 });
      receipt = true;
    }
    finally {
      if (receipt) later(() => GM_deleteValue(key), 60000); else GM_deleteValue(key);
      setBusy(false);
    }
  }

  // No cookies, corporate identifiers, or Apps Script key are sent to this API.
  function googleApi(path, { method = 'GET', body, credential = currentAuth(), allowed = [] } = {}) {
    if (!path.startsWith('/calendar/v3/') && path !== '/oauth2/v3/userinfo') throw new Error('Недопустимый путь Google API.');
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url: 'https://www.googleapis.com' + path, anonymous: true, timeout: 45000,
      headers: { Authorization: `Bearer ${credential.accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { data: JSON.stringify(body) } : {}),
      onload(response) {
        const code = Number(response.status);
        if (allowed.includes(code)) { resolve({ httpStatus: code }); return; }
        if (code === 401) { GM_deleteValue(authKey()); reject(new Error('Вход Google истёк или отозван. Подключи Google повторно в настройках.')); return; }
        if (code < 200 || code >= 300) {
          let reason = '';
          try { reason = JSON.parse(response.responseText)?.error?.errors?.[0]?.reason || ''; } catch {}
          const detail = code === 403 ? 'Проверь разрешение calendar.app.created, включение Calendar API и доступ тестового аккаунта в Google Cloud.' : code === 404 ? 'Календарь копий не найден. Проверь выбранный аккаунт; календарь мог быть удалён.' : code === 429 ? 'Превышена частота запросов. Повтори позже.' : 'Повтори запуск; уже созданные копии будут найдены по идентификаторам.';
          reject(new Error(`Google API: HTTP ${code}${/^[a-zA-Z]{1,60}$/.test(reason) ? ` (${reason})` : ''}. ${detail}`)); return;
        }
        try { resolve(response.responseText ? JSON.parse(response.responseText) : {}); }
        catch { reject(new Error('Google API вернул непонятный ответ. Синхронизация остановлена.')); }
      },
      onerror() { reject(new Error('Нет соединения с Google API. Проверь интернет и разрешение Tampermonkey на www.googleapis.com.')); },
      ontimeout() { reject(new Error('Google API не ответил. Повтори запуск: копии будут восстановлены по идентификаторам.')); }
    }));
  }

  async function calendarForAccount(auth) {
    let id = config.accounts?.[auth.account]?.calendarId;
    if (id) return id;
    const calendar = await googleApi('/calendar/v3/calendars', { method: 'POST', credential: auth,
      body: { summary: 'Работа · OWA', description: 'Копии встреч OWA. Обновляются вручную.', timeZone: config.timezone } });
    if (typeof calendar.id !== 'string' || !calendar.id) throw new Error('Google не вернул идентификатор календаря.');
    id = calendar.id;
    saveConfig({ ...config, accounts: { ...config.accounts, [auth.account]: { calendarId: id } } });
    return id;
  }

  function oauthOwned(event, owner) {
    const props = event.extendedProperties?.private;
    return props?.bridge === 'owa-google-oauth-v1' && props.owner === owner && /^[a-f0-9]{64}$/.test(props.key || '') && !event.recurrence?.length && !event.recurringEventId;
  }

  async function syncOAuth(snapshot, auth) {
    const id = await calendarForAccount(auth), base = `/calendar/v3/calendars/${encodeURIComponent(id)}/events`;
    const owner = await hash(`${config.clientId}\0${SOURCE}`);
    const query = new URLSearchParams({ timeMin: snapshot.windowStart, timeMax: snapshot.windowEnd, maxResults: '2500',
      singleEvents: 'true', privateExtendedProperty: `owner=${owner}`,
      fields: 'nextPageToken,items(id,status,start,extendedProperties,recurrence,recurringEventId)' });
    const existing = new Map(), pages = new Set();
    let pageToken = '';
    do {
      if (pageToken) query.set('pageToken', pageToken);
      const page = await googleApi(`${base}?${query}`, { credential: auth });
      if (!Array.isArray(page.items)) throw new Error('Google не вернул полный список копий. Синхронизация остановлена.');
      for (const event of page.items) {
        if (!oauthOwned(event, owner) || !event.id) throw new Error('Конфликт принадлежности копии встречи. Синхронизация остановлена.');
        const key = event.extendedProperties.private.key;
        if (existing.has(key)) throw new Error('Найдены дубли управляемой встречи. Синхронизация остановлена.');
        existing.set(key, event);
      }
      pageToken = page.nextPageToken || '';
      if (pageToken && (pages.has(pageToken) || pages.size >= 20)) throw new Error('Google не подтвердил окончание списка копий.');
      pages.add(pageToken);
    } while (pageToken);
    const totals = { created: 0, updated: 0, unchanged: 0, deleted: 0 };
    const keys = new Set();
    const changes = [];
    for (const item of snapshot.events) {
      keys.add(item.key);
      const digest = await hash(JSON.stringify(item));
      const eventId = 'b' + await hash(`${owner}\0${item.key}`);
      let event = existing.get(item.key);
      // Deterministic IDs recover moved events outside the window and unknown POST outcomes.
      if (!event) {
        const recovered = await googleApi(`${base}/${eventId}`, { credential: auth, allowed: [404] });
        if (recovered.httpStatus !== 404) {
          if (!oauthOwned(recovered, owner) || recovered.extendedProperties.private.key !== item.key) throw new Error('Конфликт идентификатора копии встречи.');
          event = recovered;
        }
      }
      if (event && event.extendedProperties.private.digest === digest) { totals.unchanged++; continue; }
      changes.push({ item, digest, eventId, event });
    }
    status(`Без изменений: ${totals.unchanged}. Нужно отправить: ${changes.length}.`);
    for (const [index, { item, digest, eventId, event }] of changes.entries()) {
      status(`Отправляю изменения: ${index + 1} / ${changes.length}. Пропущено без изменений: ${totals.unchanged}.`);
      const body = { summary: item.title, description: item.description, location: item.location,
        start: item.allDay ? { date: item.startDate } : { dateTime: item.start },
        end: item.allDay ? { date: item.endDate } : { dateTime: item.end },
        extendedProperties: { private: { bridge: 'owa-google-oauth-v1', owner, key: item.key, digest } } };
      if (event) {
        await googleApi(`${base}/${encodeURIComponent(event.id)}?sendUpdates=none`, { method: 'PUT', credential: auth, body }); totals.updated++;
      } else {
        const result = await googleApi(`${base}?sendUpdates=none`, { method: 'POST', credential: auth, body: { ...body, id: eventId }, allowed: [409] });
        if (result.httpStatus === 409) throw new Error('Копия уже создана другим запуском. Повтори синхронизацию; очистка не выполнялась.');
        totals.created++;
      }
    }
    // All writes and the complete Google listing must succeed before any deletion.
    const removals = [];
    if (snapshot.complete) for (const [key, event] of existing) {
      const start = event.start?.dateTime || (event.start?.date ? `${event.start.date}T00:00:00+03:00` : '');
      if (!Number.isFinite(Date.parse(start))) throw new Error('Копия без корректного времени. Очистка остановлена.');
      if (keys.has(key) || Date.parse(start) < Date.parse(snapshot.windowStart) || Date.parse(start) >= Date.parse(snapshot.windowEnd)) continue;
      removals.push(event);
    }
    for (const event of removals) {
      await googleApi(`${base}/${encodeURIComponent(event.id)}?sendUpdates=none`, { method: 'DELETE', credential: auth, allowed: [404, 410] }); totals.deleted++;
    }
    return totals;
  }

  function connection(value) {
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error('Вставь ссылку подключения из Google Apps Script.'); }
    const token = url.hash.slice(1);
    if (url.origin !== 'https://script.google.com' || !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url.pathname) || !/^[a-f0-9]{64}$/i.test(token)) {
      throw new Error('Нужна ссылка https://script.google.com/macros/s/…/exec#ключ из функции setup.');
    }
    url.hash = '';
    url.search = '';
    return { url: url.href, token };
  }

  function cookie(name) {
    const part = document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
    return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
  }

  function canary() {
    const target = cookie('targetServer');
    return (target && cookie(`X-OWA-CANARY_${target.toLowerCase()}`)) || cookie('X-OWA-CANARY');
  }

  function header() {
    return { ...TYPE('JsonRequestHeaders'), RequestServerVersion: 'Exchange2013',
      TimeZoneContext: { ...TYPE('TimeZoneContext'), TimeZoneDefinition: { ...TYPE('TimeZoneDefinitionType'), Id: 'UTC' } } };
  }

  function shape(fields, detail = false) {
    return { ...TYPE('ItemResponseShape'), BaseShape: 'IdOnly',
      AdditionalProperties: fields.map(FieldURI => ({ ...TYPE('PropertyUri'), FieldURI })),
      ...(detail ? { BodyType: 'HTML', FilterHtmlContent: true } : {}) };
  }

  const LIST_FIELDS = ['Subject', 'Start', 'End', 'IsAllDayEvent', 'CalendarItemType', 'UID', 'OriginalStart', 'IsCancelled'];
  const DETAIL_FIELDS = [...LIST_FIELDS, 'Body', 'Location', 'JoinOnlineMeetingUrl'];

  async function owa(action, body) {
    const token = canary();
    if (!token) throw new Error('Не вижу активного входа OWA. Открой рабочую почту и войди обычным способом, затем повтори.');
    const headers = { 'Content-Type': 'application/json; charset=utf-8', Action: action,
      'X-OWA-CANARY': token, 'X-OWA-ActionName': `${action}Action`, 'X-Requested-With': 'XMLHttpRequest' };
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45000);
      let response;
      try {
        response = await fetch(`/owa/service.svc?action=${action}&ID=-1&AC=1`, {
          method: 'POST', credentials: 'same-origin', headers,
          body: JSON.stringify({ ...TYPE(`${action}JsonRequest`), Header: header(), Body: body }), signal: controller.signal
        });
        if ([429, 502, 503, 504].includes(response.status) && attempt < 2) {
          await sleep(1000 * (attempt + 1));
          continue;
        }
        if ([401, 403, 440].includes(response.status)) throw new Error('OWA отклонил запрос. Проверь VPN и повторно войди в рабочую почту.');
        if (!response.ok) throw new Error(`OWA: HTTP ${response.status} при ${action}. Ничего не удалено в Google.`);
        let result;
        try { result = await response.json(); }
        catch { throw new Error('OWA вернул страницу входа вместо календаря. Повторно войди в почту.'); }
        const fault = result?.Body?.FaultMessage || result?.FaultMessage || result?.Body?.ExceptionName;
        if (fault) throw new Error(`OWA не принял ${action}. Эта версия требует другой формат запроса.`);
        const messages = result?.Body?.ResponseMessages?.Items;
        if (!Array.isArray(messages) || messages.length === 0) throw new Error(`Неизвестный формат ответа OWA (${action}). Отправка в Google остановлена.`);
        for (const message of messages) {
          if (message.ResponseCode !== 'NoError' || message.ResponseClass === 'Error') {
            const code = /^[A-Za-z0-9_]{1,80}$/.test(message.ResponseCode || '') ? message.ResponseCode : 'UnknownError';
            throw new Error(`OWA: ${code} при ${action}. Отправка остановлена.`);
          }
        }
        return messages;
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('OWA не ответил за 45 секунд. Проверь VPN и повтори.');
        throw error;
      } finally { clearTimeout(timeout); }
    }
  }

  function instant(value) {
    if (typeof value !== 'string') throw new Error('Встреча без корректного времени. Синхронизация остановлена.');
    const msDate = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
    const normalized = msDate ? Number(msDate[1]) : /^\d{4}-\d{2}-\d{2}T/.test(value) && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? `${value}Z` : value;
    const date = new Date(normalized);
    if (!Number.isFinite(date.getTime())) throw new Error('OWA вернул непонятную дату. Синхронизация остановлена.');
    return date.toISOString();
  }

  function dateInZone(value, timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(value));
    const get = type => parts.find(p => p.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function flag(value) { return value === true || value === 'true'; }
  function cancelled(item) { return flag(item.IsCancelled) || flag(item.IsSeriesCancelled); }

  async function findRange(start, end, depth = 0) {
    const messages = await owa('FindItem', { ...TYPE('FindItemRequest'), Traversal: 'Shallow',
      ItemShape: shape(LIST_FIELDS), ParentFolderIds: [{ ...TYPE('DistinguishedFolderId'), Id: 'calendar' }],
      Paging: { ...TYPE('CalendarPageView'), StartDate: start, EndDate: end, MaxEntriesReturned: 500 } });
    const items = [];
    let complete = true;
    let truncated = false;
    for (const message of messages) {
      const root = message.RootFolder;
      if (!root || !Array.isArray(root.Items)) throw new Error('OWA не вернул список встреч. Синхронизация остановлена.');
      const hasLast = flag(root.IncludesLastItemInRange);
      if (!hasLast) complete = false;
      if (root.IncludesLastItemInRange === false || root.IncludesLastItemInRange === 'false' || root.Items.length >= 500 || Number(root.TotalItemsInView) > root.Items.length) truncated = true;
      for (const item of root.Items) {
        if (!item.ItemId?.Id || !item.Start || !item.End || item.CalendarItemType === 'RecurringMaster') {
          throw new Error('OWA вернул неполный список или шаблон серии вместо её встреч. Синхронизация остановлена.');
        }
        items.push(item);
      }
    }
    if (truncated) {
      const from = new Date(start).getTime(), to = new Date(end).getTime();
      if (depth >= 10 || to - from < 3600000) throw new Error('Слишком много встреч в одном периоде. Ничего не удалено в Google.');
      const middle = new Date(Math.floor((from + to) / 2)).toISOString();
      const left = await findRange(start, middle, depth + 1);
      const right = await findRange(middle, end, depth + 1);
      return { items: [...left.items, ...right.items], complete: left.complete && right.complete };
    }
    return { items, complete };
  }

  function description(item) {
    const body = item.Body || item.TextBody;
    const raw = typeof body === 'string' ? body : body?.Value || '';
    let text = raw;
    if (body?.BodyType === 'HTML') {
      const template = document.createElement('template');
      template.innerHTML = raw;
      template.content.querySelectorAll('script,style,iframe,object,embed,img,svg,link,meta').forEach(node => node.remove());
      for (const anchor of template.content.querySelectorAll('a[href]')) {
        try {
          const url = new URL(anchor.getAttribute('href'));
          if (['https:', 'http:'].includes(url.protocol) && !anchor.textContent.includes(url.href)) anchor.append(document.createTextNode(` (${url.href})`));
        } catch {}
      }
      template.content.querySelectorAll('br').forEach(node => node.replaceWith(document.createTextNode('\n')));
      template.content.querySelectorAll('p,div,tr,li,h1,h2,h3').forEach(node => node.append(document.createTextNode('\n')));
      text = template.content.textContent.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    const urls = [item.JoinOnlineMeetingUrl, item.OnlineMeetingSettings?.JoinUrl];
    for (const value of urls) {
      if (typeof value === 'string' && /^https?:\/\//i.test(value) && !text.includes(value)) text += `\n\nСсылка на звонок: ${value}`;
    }
    // Calendar descriptions support HTML: encode the text instead of forwarding arbitrary source markup.
    return text.slice(0, 16000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
  }

  async function hash(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  }

  async function normalize(item) {
    const start = instant(item.Start), end = instant(item.End);
    if (new Date(end) <= new Date(start)) throw new Error('Встреча с неверным интервалом времени. Синхронизация остановлена.');
    const series = ['Occurrence', 'Exception'].includes(item.CalendarItemType);
    const identity = item.UID ? `${item.UID}\0${series ? instant(item.OriginalStart || item.Start) : 'single'}` : item.ItemId.Id;
    const allDay = flag(item.IsAllDayEvent);
    const event = { key: await hash(identity), title: String(item.Subject || '(Без названия)').slice(0, 1000),
      start, end, allDay, description: description(item), location: String(item.Location || item.EnhancedLocation?.DisplayName || '').slice(0, 2000) };
    if (allDay) {
      event.startDate = dateInZone(start, config.timezone);
      event.endDate = dateInZone(end, config.timezone);
      if (event.endDate <= event.startDate) throw new Error('Не удалось определить даты события на весь день.');
    }
    return event;
  }

  async function collect() {
    const now = new Date();
    now.setUTCHours(0, 0, 0, 0);
    const from = now.getTime() - config.pastDays * DAY;
    const to = now.getTime() + (config.futureDays + 1) * DAY;
    const found = new Map();
    let complete = true;
    for (let cursor = from; cursor < to; cursor += 7 * DAY) {
      status(`Читаю календарь: ${Math.round(100 * (cursor - from) / (to - from))}%`);
      const page = await findRange(new Date(cursor).toISOString(), new Date(Math.min(to, cursor + 7 * DAY)).toISOString());
      complete &&= page.complete;
      for (const item of page.items) found.set(item.ItemId.Id, item);
    }
    if (found.size > 1000) throw new Error('Больше 1000 встреч. Уменьши период в настройках.');
    const baseItems = [...found.values()].filter(item => !cancelled(item));
    const cacheKey = `owa-google-event-cache:${SOURCE}`;
    const savedCache = GM_getValue(cacheKey, null);
    const oldCache = savedCache?.version === 1 ? savedCache.items || {} : {};
    const cache = {}, cached = new Map(), revisions = new Map(), changed = [];
    for (const base of baseItems) {
      const id = await hash(base.ItemId.Id);
      // ChangeKey covers body-only changes. Without it, read details again.
      const revision = typeof base.ItemId.ChangeKey === 'string' && base.ItemId.ChangeKey
        ? await hash(JSON.stringify([config.timezone, base.ItemId.ChangeKey, ...LIST_FIELDS.map(name => base[name] ?? null)])) : null;
      revisions.set(base.ItemId.Id, { id, revision });
      const entry = oldCache[id];
      if (revision && entry?.revision === revision && entry.event?.key && entry.event.start && entry.event.end && typeof entry.event.description === 'string') {
        cached.set(base.ItemId.Id, entry.event); cache[id] = entry;
      } else changed.push(base);
    }
    status(`Встреч ${baseItems.length}: без изменений ${cached.size}, читаю новые и изменённые ${changed.length}.`);
    const details = new Map();
    for (let offset = 0; offset < changed.length; offset += 20) {
      status(`Читаю новые и изменённые: ${offset} / ${changed.length}. Пропущено: ${cached.size}.`);
      const batch = changed.slice(offset, offset + 20);
      const messages = await owa('GetItem', { ...TYPE('GetItemRequest'), ItemShape: shape(DETAIL_FIELDS, true),
        ItemIds: batch.map(item => ({ ...TYPE('ItemId'), Id: item.ItemId.Id })) });
      for (const message of messages) {
        if (!Array.isArray(message.Items)) throw new Error('OWA не вернул детали встреч. Отправка остановлена.');
        for (const item of message.Items) if (item.ItemId?.Id) details.set(item.ItemId.Id, item);
      }
    }
    const events = new Map();
    for (const base of baseItems) {
      let event = cached.get(base.ItemId.Id);
      if (!event) {
        const detail = details.get(base.ItemId.Id);
        if (!detail) throw new Error('Не удалось прочитать одну из встреч. Отправка остановлена; повтори запуск.');
        const item = { ...base, ...detail };
        if (cancelled(item)) continue;
        event = await normalize(item);
        const { id, revision } = revisions.get(base.ItemId.Id);
        if (revision) cache[id] = { revision, event };
      }
      if (new Date(event.end).getTime() > from && new Date(event.start).getTime() < to) events.set(event.key, event);
    }
    GM_setValue(cacheKey, { version: 1, items: cache });
    return { version: VERSION, source: SOURCE, clientId: config.clientId, timezone: config.timezone,
      windowStart: new Date(from).toISOString(), windowEnd: new Date(to).toISOString(), complete,
      events: [...events.values()].sort((a, b) => a.start.localeCompare(b.start)) };
  }

  function googleResponse(response) {
    const text = typeof response.responseText === 'string' ? response.responseText : '';
    let result;
    try { result = JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch {
      let host = '';
      try { host = new URL(response.finalUrl).hostname; } catch {}
      if (host === 'accounts.google.com' || /(?:<title[^>]*>\s*(?:Sign in|Вход)|ServiceLogin|accounts\.google\.com\/v\d\/signin)/i.test(text)) {
        throw new Error('Google требует входа. В Apps Script: Управление развертываниями → карандаш → выполнять от имени «Я», доступ «Все», включая пользователей без входа.');
      }
      if (/Script function not found\s*:\s*doPost|Функция скрипта не найдена\s*:\s*doPost/i.test(text)) {
        throw new Error('В опубликованной версии нет doPost. В Apps Script обнови существующее развертывание до новой версии с кодом обработчика.');
      }
      if ([401, 403].includes(Number(response.status))) {
        throw new Error('Google запретил доступ. Проверь настройки развертывания: выполнять от имени «Я», доступ «Все», включая пользователей без входа.');
      }
      throw new Error(`Google вернул страницу вместо ответа обработчика${response.status ? ` (HTTP ${Number(response.status)})` : ''}. Проверь ссылку /exec и текущую версию развертывания.`);
    }
    if (!result || typeof result !== 'object' || !result.ok) throw new Error(result?.error || 'Google: синхронизация не выполнена.');
    return result;
  }

  function google(payload) {
    const target = connection(config.connection);
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'POST', url: target.url, anonymous: true, timeout: 180000,
      headers: { 'Content-Type': 'application/json' }, data: JSON.stringify({ ...payload, token: target.token }),
      onload(response) {
        try { resolve(googleResponse(response)); }
        catch (error) { reject(error); }
      },
      onerror() { reject(new Error('Не удалось связаться с Google. Проверь разрешение Tampermonkey на script.google.com и доступ к интернету.')); },
      ontimeout() { reject(new Error('Google долго отвечает. Повтори запуск: уже созданные встречи будут обновлены без дублей.')); }
    }));
  }

  async function receiptKey() {
    return `owa-google-receipts:${SOURCE}:${await hash(`${config.clientId}\0${config.connection}`)}`;
  }

  async function syncAppsScript(snapshot) {
    const key = await receiptKey();
    const saved = GM_getValue(key, null);
    const receipts = saved?.version === 1 ? { ...saved.items } : {};
    const pending = [], totals = { created: 0, updated: 0, unchanged: 0, deleted: 0 };
    for (const event of snapshot.events) {
      const digest = await hash(JSON.stringify(event)), receipt = receipts[event.key];
      if (receipt?.digest === digest && Date.now() - receipt.at < DAY) totals.unchanged++;
      else pending.push({ event, digest });
    }
    const { events, ...metadata } = snapshot;
    for (let offset = 0; offset < pending.length; offset += 15) {
      const batch = pending.slice(offset, offset + 15);
      status(`Отправляю изменения: ${offset + batch.length} / ${pending.length}. Пропущено без изменений: ${totals.unchanged}.`);
      const result = await google({ ...metadata, op: 'upsert', events: batch.map(item => item.event) });
      for (const name of ['created', 'updated', 'unchanged']) totals[name] += result[name] || 0;
      for (const item of batch) receipts[item.event.key] = { digest: item.digest, at: Date.now() };
      GM_setValue(key, { version: 1, items: receipts });
    }
    if (snapshot.complete) {
      status('Проверяю отмены и переносы…');
      const result = await google({ ...metadata, op: 'finalize', keys: events.map(event => event.key) });
      totals.deleted = result.deleted || 0;
      const keys = new Set(events.map(event => event.key));
      for (const id of Object.keys(receipts)) if (!keys.has(id)) delete receipts[id];
      GM_setValue(key, { version: 1, items: receipts });
    }
    return totals;
  }

  async function resetSyncCache() {
    if (busy) return;
    GM_deleteValue(`owa-google-event-cache:${SOURCE}`);
    GM_deleteValue(await receiptKey());
    status('Сохранённые версии сброшены. Следующая синхронизация выполнит полную проверку встреч.');
  }

  function status(text, error = false) {
    if (!ui) return;
    ui.status.textContent = text;
    ui.status.style.color = error ? '#b42318' : '#475467';
  }

  function setBusy(value) {
    busy = value;
    for (const button of [ui.sync, ui.preview, ui.exportButton, ui.settings, ui.oauthLogin, ui.oauthDisconnect, ui.save, ui.cancel, ui.mode]) button.disabled = value;
    ui.sync.textContent = value ? 'Синхронизация…' : 'Синхронизировать';
  }

  async function sync() {
    if (busy) return;
    if (config.mode === 'apps-script' && !config.connection) { settings(); return; }
    if (config.mode === 'oauth') {
      try { currentAuth(); } catch { settings(); ui.dialogError.textContent = 'Нажми «Войти через Google», чтобы подключить календарь.'; return; }
    }
    setBusy(true);
    try {
      status('Проверяю подключение Google…');
      const auth = config.mode === 'oauth' ? currentAuth() : null;
      if (!auth) { connection(config.connection); await google({ op: 'ping', version: VERSION }); }
      const snapshot = await collect();
      lastSnapshot = snapshot;
      const totals = auth ? await syncOAuth(snapshot, auth) : await syncAppsScript(snapshot);
      status(`Готово: новых ${totals.created}, обновлено ${totals.updated}, без изменений ${totals.unchanged}, удалено ${totals.deleted}.${snapshot.complete ? '' : ' OWA не подтвердил полный список — удаления пропущены.'}`);
    } catch (error) { status(error.message || 'Синхронизация не выполнена.', true); }
    finally { setBusy(false); }
  }

  async function preview() {
    if (busy) return;
    setBusy(true);
    try {
      lastSnapshot = await collect();
      ui.list.replaceChildren();
      for (const event of lastSnapshot.events.slice(0, 12)) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:7px 0;border-bottom:1px solid #eaecf0';
        row.textContent = `${new Date(event.start).toLocaleString('ru-RU', { timeZone: config.timezone })} — ${event.title}`;
        ui.list.append(row);
      }
      ui.list.hidden = false;
      status(`Прочитано ${lastSnapshot.events.length} встреч. Это просмотр; в Google ничего не отправлено.`);
    } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  }

  function icsEscape(text) { return String(text).replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,'); }
  function icsDate(text) { return text.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }
  function fold(line) {
    const encoder = new TextEncoder();
    let bytes = 0, part = '', result = '';
    for (const char of line) {
      const size = encoder.encode(char).length;
      if (bytes + size > 73) { result += `${part}\r\n `; part = ''; bytes = 1; }
      part += char; bytes += size;
    }
    return result + part;
  }

  async function exportIcs() {
    if (busy) return;
    setBusy(true);
    try {
      const snapshot = await collect();
      lastSnapshot = snapshot;
      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Local Calendar Bridge//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Работа'];
      for (const event of snapshot.events) {
        const body = document.createElement('template'); body.innerHTML = event.description.replace(/<br>/g, '\n');
        lines.push('BEGIN:VEVENT', `UID:${event.key}@local.calendar-bridge`, `DTSTAMP:${icsDate(new Date().toISOString())}`,
          event.allDay ? `DTSTART;VALUE=DATE:${event.startDate.replace(/-/g, '')}` : `DTSTART:${icsDate(event.start)}`,
          event.allDay ? `DTEND;VALUE=DATE:${event.endDate.replace(/-/g, '')}` : `DTEND:${icsDate(event.end)}`,
          `SUMMARY:${icsEscape(event.title)}`, `LOCATION:${icsEscape(event.location)}`, `DESCRIPTION:${icsEscape(body.content.textContent)}`, 'END:VEVENT');
      }
      lines.push('END:VCALENDAR');
      const url = URL.createObjectURL(new Blob([lines.map(fold).join('\r\n') + '\r\n'], { type: 'text/calendar;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'Работа.ics'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      status(`Скачано ${snapshot.events.length} встреч. ICS — разовый экспорт; для обновлений используй «Синхронизировать».`);
    } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  }

  function settings() {
    if (busy) return;
    ui.dialog.showModal();
    ui.connection.value = config.connection;
    ui.future.value = String(config.futureDays);
    ui.mode.value = config.mode;
    updateAccountLabel();
    updateModeDisplay();
    ui.dialogError.textContent = '';
  }

  function updateAccountLabel() {
    const auth = GM_getValue(authKey(), null);
    ui.account.textContent = auth?.email ? `${auth.email}${auth.expires <= Date.now() ? ' — нужно войти повторно' : ' — подключён'}` : 'Google пока не подключён.';
    ui.oauthDisconnect.hidden = !auth;
  }

  function updateModeDisplay() {
    ui.oauthSettings.hidden = ui.mode.value !== 'oauth';
    ui.scriptSettings.hidden = ui.mode.value !== 'apps-script';
  }

  function mount() {
    if (document.getElementById('owa-google-bridge')) return;
    const host = document.createElement('div'); host.id = 'owa-google-bridge';
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;width:330px;max-width:calc(100vw - 24px)';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      :host{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#101828}
      *{box-sizing:border-box}.card{background:#fff;border:1px solid #e4e7ec;border-radius:14px;padding:14px;box-shadow:0 6px 28px #0002}
      .top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}strong{font-size:14px}
      button{font:inherit;cursor:pointer;border:1px solid #d0d5dd;background:#fff;border-radius:8px;padding:7px 10px;color:#344054}
      button:disabled{opacity:.55;cursor:wait}.primary{background:#1769e0;border-color:#1769e0;color:#fff;font-weight:600;width:100%;padding:10px}
      .tools{display:flex;gap:8px;margin-top:9px}.tools button{flex:1;font-size:12px}.status{margin-top:9px;font-size:12px;overflow-wrap:anywhere}
      .list{max-height:240px;overflow:auto;font-size:12px}.icon{border:0;padding:3px 7px}dialog{font:13px/1.5 "Segoe UI",sans-serif;color:#101828;width:460px;max-width:94vw;border:1px solid #d0d5dd;border-radius:14px;padding:22px;box-shadow:0 10px 50px #0003}
      dialog::backdrop{background:#0004}h2{margin:0 0 12px;font-size:19px}label{display:block;margin-top:14px}input,select{font:inherit;padding:9px;border:1px solid #d0d5dd;border-radius:8px;width:100%;margin-top:5px}a{color:#1769e0}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}.muted{color:#667085;font-size:12px}.error{color:#b42318}
    </style><div class="card"><div class="top"><strong>Работа → Google Календарь</strong><span><button class="icon" id="settings" title="Настройки">⚙</button><button class="icon" id="collapse" title="Свернуть">−</button></span></div>
      <div id="content"><button class="primary" id="sync">Синхронизировать</button><div class="tools"><button id="preview">Просмотр</button><button id="export">Скачать ICS</button></div>
      <div class="status" id="status">VPN включён, OWA открыт — можно запускать.</div><div class="list" id="list" hidden></div></div></div>
      <dialog id="dialog"><h2>Подключить Google</h2>
      <label>Способ подключения<select id="mode"><option value="oauth">Войти через Google</option><option value="apps-script">Мой Google Apps Script</option></select></label>
      <div id="oauth-settings"><p>Войди в свой Google аккаунт и разреши создание календаря копий «Работа · OWA».</p>
      <button id="oauth-login" class="primary">Войти через Google</button><p id="account" class="muted"></p><button id="oauth-disconnect">Отключить на этом устройстве</button>
      <p class="muted">Вход действует ограниченное время. При истечении нажми эту кнопку снова. Существующие копии сохранятся.</p></div>
      <div id="script-settings"><p>Собственный обработчик Apps Script создаёт отдельный календарь «Работа».</p>
      <p class="muted"><a href="https://mainiken.github.io/owa-calendar-bridge/INSTALL.html#apps-script" target="_blank" rel="noopener noreferrer">Инструкция для Apps Script</a></p>
      <label>Ссылка подключения<input id="connection" type="password" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec#ключ"></label>
      </div>
      <label>На сколько дней вперёд<select id="future"><option value="30">30 дней</option><option value="60">60 дней</option><option value="90">90 дней</option></select></label>
      <p class="muted">Также обновляются последние 7 дней. В Google переносятся название, время, место, описание и ссылки на звонок.</p><p class="error" id="error"></p>
      <div class="actions"><button id="cancel">Закрыть</button><button id="save">Сохранить</button></div></dialog>`;
    const get = id => root.getElementById(id);
    ui = { sync: get('sync'), preview: get('preview'), exportButton: get('export'), settings: get('settings'), status: get('status'), list: get('list'),
      dialog: get('dialog'), connection: get('connection'), future: get('future'), dialogError: get('error'), mode: get('mode'),
      oauthLogin: get('oauth-login'), oauthDisconnect: get('oauth-disconnect'), account: get('account'),
      oauthSettings: get('oauth-settings'), scriptSettings: get('script-settings'), save: get('save'), cancel: get('cancel') };
    ui.sync.addEventListener('click', sync); ui.preview.addEventListener('click', preview); ui.exportButton.addEventListener('click', exportIcs);
    ui.settings.addEventListener('click', settings);
    ui.mode.addEventListener('change', updateModeDisplay);
    ui.oauthLogin.addEventListener('click', connectGoogle);
    ui.oauthDisconnect.addEventListener('click', () => {
      GM_deleteValue(authKey()); updateAccountLabel();
      ui.dialogError.textContent = 'Вход удалён с этого устройства. Для отзыва разрешения приложению используй myaccount.google.com/connections. Копии встреч сохранены.';
    });
    ui.dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
    get('collapse').addEventListener('click', () => { get('content').hidden = !get('content').hidden; get('collapse').textContent = get('content').hidden ? '+' : '−'; });
    get('cancel').addEventListener('click', () => ui.dialog.close());
    get('save').addEventListener('click', () => {
      try {
        if (ui.connection.value.trim()) connection(ui.connection.value);
        saveConfig({ ...config, mode: ui.mode.value, connection: ui.connection.value.trim(), futureDays: Number(ui.future.value) });
        ui.dialog.close(); status('Настройки сохранены. Можно запускать синхронизацию.');
      } catch (error) { ui.dialogError.textContent = error.message; }
    });
    document.body.append(host);
  }

  // The test harness exposes internals only when evaluating this source in an isolated VM.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { connection, instant, flag, cancelled, dateInZone, normalize, findRange, collect, owa, hash, fold, icsEscape, header, shape, googleResponse, googleApi, syncOAuth, syncAppsScript, currentAuth, oauthOwned };
  } else {
    GM_setValue(STORAGE, config);
    mount();
    GM_registerMenuCommand('Настройки синхронизации календаря', settings);
    GM_registerMenuCommand('Полная проверка при следующей синхронизации', resetSyncCache);
  }
})();
