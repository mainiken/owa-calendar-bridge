// ==UserScript==
// @name         OWA → Google: мой календарь
// @namespace    local.calendar-bridge
// @version      1.2.1
// @description  Ручная синхронизация встреч из открытого OWA в отдельный Google Календарь.
// @match        https://*/owa/*
// @exclude      https://*/owa/calendar/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      script.google.com
// @connect      script.googleusercontent.com
// ==/UserScript==

(() => {
  'use strict';
  const VERSION = 1;
  const STORAGE = 'owa-google-bridge-v1';
  const SOURCE = location.hostname.toLowerCase();
  const DAY = 86400000;
  const TYPE = name => ({ __type: `${name}:#Exchange` });
  let config = loadConfig();
  let busy = false;
  let lastSnapshot = null;
  let ui;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function loadConfig() {
    const saved = GM_getValue(STORAGE, null);
    return Object.assign({ clientId: crypto.randomUUID(), connection: '', pastDays: 7, futureDays: 60, timezone: 'Europe/Moscow' }, saved || {});
  }

  function saveConfig(next) {
    config = next;
    GM_setValue(STORAGE, config);
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
    const details = new Map();
    for (let offset = 0; offset < baseItems.length; offset += 20) {
      status(`Читаю описания: ${offset} / ${baseItems.length}`);
      const batch = baseItems.slice(offset, offset + 20);
      const messages = await owa('GetItem', { ...TYPE('GetItemRequest'), ItemShape: shape(DETAIL_FIELDS, true),
        ItemIds: batch.map(item => ({ ...TYPE('ItemId'), Id: item.ItemId.Id })) });
      for (const message of messages) {
        if (!Array.isArray(message.Items)) throw new Error('OWA не вернул детали встреч. Отправка остановлена.');
        for (const item of message.Items) if (item.ItemId?.Id) details.set(item.ItemId.Id, item);
      }
    }
    const events = new Map();
    for (const base of baseItems) {
      const detail = details.get(base.ItemId.Id);
      if (!detail) throw new Error('Не удалось прочитать одну из встреч. Отправка остановлена; повтори запуск.');
      const item = { ...base, ...detail };
      if (cancelled(item)) continue;
      const event = await normalize(item);
      if (new Date(event.end).getTime() > from && new Date(event.start).getTime() < to) events.set(event.key, event);
    }
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

  function status(text, error = false) {
    if (!ui) return;
    ui.status.textContent = text;
    ui.status.style.color = error ? '#b42318' : '#475467';
  }

  function setBusy(value) {
    busy = value;
    for (const button of [ui.sync, ui.preview, ui.exportButton, ui.settings]) button.disabled = value;
    ui.sync.textContent = value ? 'Синхронизация…' : 'Синхронизировать';
  }

  async function sync() {
    if (busy) return;
    if (!config.connection) { settings(); return; }
    setBusy(true);
    try {
      connection(config.connection);
      status('Проверяю подключение Google…');
      await google({ op: 'ping', version: VERSION });
      const snapshot = await collect();
      lastSnapshot = snapshot;
      const { events, ...metadata } = snapshot;
      const totals = { created: 0, updated: 0, unchanged: 0, deleted: 0 };
      for (let offset = 0; offset < events.length; offset += 15) {
        status(`Отправляю в Google: ${offset} / ${events.length}`);
        const result = await google({ ...metadata, op: 'upsert', events: events.slice(offset, offset + 15) });
        for (const name of ['created', 'updated', 'unchanged']) totals[name] += result[name] || 0;
      }
      if (snapshot.complete) {
        status('Проверяю отмены и переносы…');
        const result = await google({ ...metadata, op: 'finalize', keys: events.map(event => event.key) });
        totals.deleted = result.deleted || 0;
      }
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
    ui.dialogError.textContent = '';
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
      <dialog id="dialog"><h2>Подключить Google</h2><p>Один раз установи обработчик в своём Google Apps Script. Он создаст отдельный календарь «Работа».</p>
      <p class="muted">Код и пошаговая установка — в файлах GoogleCalendarBridge.gs и INSTALL.html, которые идут вместе с этим скриптом.</p>
      <label>Ссылка подключения<input id="connection" type="password" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec#ключ"></label>
      <label>На сколько дней вперёд<select id="future"><option value="30">30 дней</option><option value="60">60 дней</option><option value="90">90 дней</option></select></label>
      <p class="muted">Также обновляются последние 7 дней. В Google переносятся название, время, место, описание и ссылки на звонок.</p><p class="error" id="error"></p>
      <div class="actions"><button id="cancel">Закрыть</button><button id="save">Сохранить</button></div></dialog>`;
    const get = id => root.getElementById(id);
    ui = { sync: get('sync'), preview: get('preview'), exportButton: get('export'), settings: get('settings'), status: get('status'), list: get('list'),
      dialog: get('dialog'), connection: get('connection'), future: get('future'), dialogError: get('error') };
    ui.sync.addEventListener('click', sync); ui.preview.addEventListener('click', preview); ui.exportButton.addEventListener('click', exportIcs);
    ui.settings.addEventListener('click', settings);
    get('collapse').addEventListener('click', () => { get('content').hidden = !get('content').hidden; get('collapse').textContent = get('content').hidden ? '+' : '−'; });
    get('cancel').addEventListener('click', () => ui.dialog.close());
    get('save').addEventListener('click', () => {
      try {
        if (ui.connection.value.trim()) connection(ui.connection.value);
        saveConfig({ ...config, connection: ui.connection.value.trim(), futureDays: Number(ui.future.value) });
        ui.dialog.close(); status(config.connection ? 'Google подключён. Нажми «Синхронизировать».' : 'Можно посмотреть встречи или скачать ICS.');
      } catch (error) { ui.dialogError.textContent = error.message; }
    });
    document.body.append(host);
  }

  // The test harness exposes internals only when evaluating this source in an isolated VM.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { connection, instant, flag, cancelled, dateInZone, normalize, findRange, collect, owa, hash, fold, icsEscape, header, shape, googleResponse };
  } else {
    GM_setValue(STORAGE, config);
    mount();
    GM_registerMenuCommand('Настройки синхронизации календаря', settings);
  }
})();
