/* Google Apps Script receiver. Deploy in YOUR PERSONAL Google account.
 * Run setup once AFTER deploying as Web app, Execute as: Me, Access: Anyone.
 * Paste the connection link printed by setup into the userscript settings.
 * The random bearer key is sent only in the POST body, never as a query parameter.
 */
var BRIDGE_VERSION = 1;
var BRIDGE_TAG = 'owa-google-bridge-v1';
var BRIDGE_DAY = 86400000;

function setup() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var props = PropertiesService.getScriptProperties();
    var token = props.getProperty('BRIDGE_TOKEN');
    if (!token) {
      token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
      props.setProperty('BRIDGE_TOKEN', token);
    }
    var calendar = bridgeCalendar_(true);
    var url = props.getProperty('BRIDGE_WEB_APP_URL') || ScriptApp.getService().getUrl();
    if (!url || !/\/exec$/.test(url)) {
      Logger.log('Календарь готов. Ключ подключения:');
      Logger.log(token);
      Logger.log('Если приложение уже развернуто, возьми его ссылку /exec из окна развертывания и допиши # и ключ. Получившуюся строку вставь в настройки OWA.');
      Logger.log('Если приложение ещё не развернуто: Deploy → New deployment → Web app, Execute as: Me, Access: Anyone.');
      return;
    }
    Logger.log('Скопируй эту ссылку целиком в настройки кнопки OWA:');
    Logger.log(url + '#' + token);
    Logger.log('Календарь: ' + calendar.getName());
  } finally { lock.releaseLock(); }
}

function showConnectionKey() {
  var token = PropertiesService.getScriptProperties().getProperty('BRIDGE_TOKEN');
  if (!token) throw new Error('Сначала запусти setup.');
  Logger.log('Допиши к своей ссылке /exec знак # и этот ключ:');
  Logger.log(token);
}

function rotateConnectionKey() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    PropertiesService.getScriptProperties().setProperty('BRIDGE_TOKEN', token);
    Logger.log('Ключ заменён. Допиши к своей ссылке /exec знак # и новый ключ, затем сохрани её в настройках OWA:');
    Logger.log(token);
  } finally { lock.releaseLock(); }
}

function bridgeCalendar_(create) {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('BRIDGE_CALENDAR_ID');
  var calendar = id ? CalendarApp.getCalendarById(id) : null;
  if (!calendar && !create) throw new Error('Календарь «Работа» не найден. Запусти setup в Google Apps Script.');
  if (!calendar) {
    calendar = CalendarApp.createCalendar('Работа', {
      description: 'Личные копии встреч из OWA. Обновляются вручную кнопкой синхронизации.', timeZone: 'Europe/Moscow'
    });
    calendar.setSelected(true);
    props.setProperty('BRIDGE_CALENDAR_ID', calendar.getId());
  }
  return calendar;
}

function bridgeJson_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return bridgeJson_({ ok: true, service: 'OWA Calendar Bridge', version: BRIDGE_VERSION, message: 'Используй кнопку синхронизации в OWA.' });
}

function doPost(e) {
  var lock;
  try {
    if (!e || !e.postData || e.postData.contents.length > 1500000) throw new Error('Некорректный или слишком большой запрос.');
    var data;
    try { data = JSON.parse(e.postData.contents); } catch (_) { throw new Error('Некорректный JSON.'); }
    var expected = PropertiesService.getScriptProperties().getProperty('BRIDGE_TOKEN');
    if (!expected || !bridgeEqual_(expected, data.token)) throw new Error('Неверный ключ подключения. Запусти setup и скопируй ссылку заново.');
    if (data.version !== BRIDGE_VERSION) throw new Error('Версии обработчика и userscript не совпадают.');
    if (data.op === 'ping') {
      var ready = bridgeCalendar_(false);
      return bridgeJson_({ ok: true, version: BRIDGE_VERSION, calendarName: ready.getName() });
    }
    if (data.op !== 'upsert' && data.op !== 'finalize') throw new Error('Неизвестная операция.');
    var range = bridgeValidate_(data);
    // Validate ALL incoming events before any calendar mutation.
    var events = data.op === 'upsert' ? bridgeEvents_(data.events, range) : null;
    var keys = data.op === 'finalize' ? bridgeKeys_(data.keys, data.complete) : null;
    lock = LockService.getScriptLock();
    if (!lock.tryLock(1000)) throw new Error('Уже идёт другой запуск. Повтори синхронизацию через минуту.');
    var calendar = bridgeCalendar_(false);
    bridgeBindSource_(data);
    var result = data.op === 'upsert' ? bridgeUpsert_(calendar, data, events, range) : bridgeFinalize_(calendar, data, keys, range);
    result.ok = true;
    return bridgeJson_(result);
  } catch (error) {
    // Calendar service error messages can include private values. Return only our own controlled messages.
    var text = String(error.message || '');
    var known = /^(?:Некоррект|Неверный|Версии|Неизвестная|Календарь|Уже идёт|Список|Период|Событие|Не подтверждён|Повторяющийся|Конфликт|Слишком)/.test(text);
    return bridgeJson_({ ok: false, error: known ? text : 'Google не завершил операцию. Повтори запуск; если ошибка повторяется, проверь журнал выполнения Apps Script.' });
  } finally { if (lock) lock.releaseLock(); }
}

function bridgeEqual_(left, right) {
  if (typeof right !== 'string' || left.length !== right.length) return false;
  var diff = 0;
  for (var i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function bridgeDate_(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text)) throw new Error('Некорректная дата.');
  var date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error('Некорректная дата.');
  return date;
}

function bridgeValidate_(data) {
  if (typeof data.source !== 'string' || data.source.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(data.source) || typeof data.clientId !== 'string' || !/^[a-f0-9-]{36}$/i.test(data.clientId)) throw new Error('Некорректный источник.');
  if (data.timezone !== 'Europe/Moscow') throw new Error('Неизвестная временная зона.');
  var start = bridgeDate_(data.windowStart), end = bridgeDate_(data.windowEnd);
  if (end <= start || end - start > 100 * BRIDGE_DAY) throw new Error('Период синхронизации должен быть не больше 100 дней.');
  return { start: start, end: end };
}

function bridgeBindSource_(data) {
  var props = PropertiesService.getScriptProperties();
  var name = 'source:' + data.clientId;
  var saved = props.getProperty(name);
  if (saved && saved !== data.source) throw new Error('Конфликт источника: этот профиль уже связан с другим сервером OWA.');
  if (!saved) props.setProperty(name, data.source);
}

function bridgeEvents_(items, range) {
  if (!Array.isArray(items) || items.length > 15) throw new Error('Список встреч должен содержать не больше 15 записей за запрос.');
  var seen = Object.create(null);
  return items.map(function (item) {
    if (!item || !/^[a-f0-9]{64}$/.test(item.key || '') || seen[item.key]) throw new Error('Некорректный или повторяющийся ключ встречи.');
    seen[item.key] = true;
    for (var field of ['title', 'description', 'location']) {
      var limit = field === 'title' ? 1000 : field === 'location' ? 2000 : 100000;
      if (typeof item[field] !== 'string' || item[field].length > limit) throw new Error('Событие содержит некорректные данные.');
    }
    if (typeof item.allDay !== 'boolean') throw new Error('Событие содержит некорректный тип времени.');
    var start = bridgeDate_(item.start), end = bridgeDate_(item.end);
    if (end <= start || end <= range.start || start >= range.end) throw new Error('Событие находится вне периода синхронизации.');
    var result = { key: item.key, title: item.title, description: item.description, location: item.location,
      start: item.start, end: item.end, allDay: item.allDay };
    if (item.allDay) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(item.startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(item.endDate || '') || item.endDate <= item.startDate) throw new Error('Событие на весь день имеет некорректные даты.');
      if (Utilities.formatDate(start, 'Europe/Moscow', 'yyyy-MM-dd') !== item.startDate || Utilities.formatDate(end, 'Europe/Moscow', 'yyyy-MM-dd') !== item.endDate) throw new Error('Событие на весь день имеет несогласованные даты.');
      result.startDate = item.startDate; result.endDate = item.endDate;
    }
    return result;
  });
}

function bridgeKeys_(keys, complete) {
  if (complete !== true) throw new Error('Не подтверждён полный список встреч: удаление запрещено.');
  if (!Array.isArray(keys) || keys.length > 1000 || keys.some(function (key) { return !/^[a-f0-9]{64}$/.test(key); })) throw new Error('Некорректный список ключей встреч.');
  return new Set(keys);
}

function bridgeDigest_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8)
    .map(function (byte) { return ((byte + 256) % 256).toString(16).padStart(2, '0'); }).join('');
}

function bridgeOwned_(event, clientId) {
  if (event.getTag('bridge') === BRIDGE_TAG && event.getTag('bridgeClient') === clientId) return true;
  // Ownership marker is written atomically with event creation. Recover if a timeout
  // happened before tags or the ID mapping could be saved.
  var recovered = bridgeMarker_(event.getDescription(), clientId);
  if (!recovered) return false;
  event.setTag('bridge', BRIDGE_TAG).setTag('bridgeClient', clientId).setTag('bridgeKey', recovered);
  return true;
}

function bridgeMarker_(description, clientId) {
  var match = /<!--owa-calendar-bridge:([a-f0-9-]{36}):([a-f0-9]{64})-->/.exec(description || '');
  return match && match[1] === clientId ? match[2] : null;
}

function bridgeDescription_(item, clientId) {
  return item.description + '\n<!--owa-calendar-bridge:' + clientId + ':' + item.key + '-->';
}

function bridgeIndex_(calendar, data, range) {
  var index = Object.create(null);
  for (var event of calendar.getEvents(range.start, range.end)) {
    if (!bridgeOwned_(event, data.clientId)) continue;
    if (event.isRecurringEvent()) throw new Error('Повторяющийся объект в календаре копий. Удали вручную изменённую серию и повтори.');
    var key = event.getTag('bridgeKey');
    if (key && index[key]) throw new Error('Конфликт копий: найден дубль одной встречи. Удали лишнюю копию и повтори.');
    if (key) index[key] = event;
  }
  return index;
}

function bridgeAllDayDate_(date) {
  // CalendarApp interprets date-only arguments in the SCRIPT's timezone.
  // Match that timezone, even when the project was created with a different default.
  return Utilities.parseDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function bridgeUpsert_(calendar, data, items, range) {
  var props = PropertiesService.getScriptProperties();
  var saved = props.getProperties();
  var recoveryIndex = null;
  var count = { created: 0, updated: 0, unchanged: 0 };
  for (var item of items) {
    var mapKey = 'event:' + data.clientId + ':' + item.key;
    var mapped = saved[mapKey];
    var event = mapped ? calendar.getEventById(mapped) : null;
    if (event) {
      if (event && (!bridgeOwned_(event, data.clientId) || event.getTag('bridgeKey') !== item.key || event.isRecurringEvent())) throw new Error('Конфликт сохранённой копии встречи.');
    }
    if (!event) {
      if (!recoveryIndex) recoveryIndex = bridgeIndex_(calendar, data, range);
      event = recoveryIndex[item.key] || null;
    }
    var digest = bridgeDigest_(item);
    if (event && event.getTag('bridgeHash') === digest) {
      count.unchanged++;
      props.setProperty(mapKey, event.getId());
      continue;
    }
    var start = new Date(item.start), end = new Date(item.end);
    var options = { description: bridgeDescription_(item, data.clientId), location: item.location, sendInvites: false };
    if (!event) {
      event = item.allDay ? calendar.createAllDayEvent(item.title, bridgeAllDayDate_(item.startDate), bridgeAllDayDate_(item.endDate), options)
        : calendar.createEvent(item.title, start, end, options);
      // Record ownership and mapping before the remaining operations, so a retry can recover this copy.
      event.setTag('bridge', BRIDGE_TAG).setTag('bridgeClient', data.clientId).setTag('bridgeKey', item.key);
      props.setProperty(mapKey, event.getId());
      count.created++;
    } else {
      if (item.allDay) event.setAllDayDates(bridgeAllDayDate_(item.startDate), bridgeAllDayDate_(item.endDate));
      else event.setTime(start, end);
      event.setTitle(item.title).setDescription(bridgeDescription_(item, data.clientId)).setLocation(item.location);
      count.updated++;
    }
    event.setTag('bridgeHash', digest);
    props.setProperty(mapKey, event.getId());
  }
  return count;
}

function bridgeFinalize_(calendar, data, keys, range) {
  var count = { deleted: 0 };
  var props = PropertiesService.getScriptProperties();
  var index = bridgeIndex_(calendar, data, range);
  // Validate the entire ownership index before starting any deletions.
  for (var key of Object.keys(index)) {
    var event = index[key];
    var start = event.getStartTime();
    if (start < range.start || start >= range.end || keys.has(key)) continue;
    event.deleteEvent();
    props.deleteProperty('event:' + data.clientId + ':' + key);
    count.deleted++;
  }
  return count;
}
