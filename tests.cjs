const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');
const clientId = '01234567-89ab-4cde-8fab-0123456789ab';
const token = 'a'.repeat(64);
const keyA = 'b'.repeat(64), keyB = 'c'.repeat(64);
const failures = [];
let passed = 0;
class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-10-14T10:00:00.000Z'])); }
  static now() { return Date.parse('2026-10-14T10:00:00.000Z'); }
}
async function test(name, fn) {
  try { await fn(); console.log(`PASS ${name}`); passed++; }
  catch (error) { console.error(`FAIL ${name}: ${error.stack}`); failures.push(name); }
}

function clientHarness(fetchImplementation) {
  const context = {
    module: { exports: {} }, crypto: crypto.webcrypto, TextEncoder, URL, URLSearchParams, AbortController,
    setTimeout, clearTimeout, console, Blob, Intl, Date: FixtureDate, location: { hostname: 'owa.example.com' },
    GM_getValue: () => ({ clientId }), GM_setValue: () => {},
    document: { cookie: 'X-OWA-CANARY=PRIVATE_CANARY' },
    fetch: fetchImplementation || (() => { throw new Error('Unexpected fetch'); })
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'owa-google-sync.user.js'), 'utf8'), context);
  return context.module.exports;
}

function serverHarness() {
  const values = { BRIDGE_TOKEN: token, BRIDGE_CALENDAR_ID: 'dedicated-calendar' };
  const events = [];
  let serial = 0, mutations = 0, scriptTimezone = 'Europe/Moscow', injectedTagFailure = false;
  const props = {
    getProperty(key) { return values[key] || null; },
    setProperty(key, value) { values[key] = value; return this; },
    deleteProperty(key) { delete values[key]; },
    getProperties() { return { ...values }; }
  };
  class Event {
    constructor(title, start, end, options = {}, allDay = false) {
      this.id = `event-${++serial}`; this.title = title; this.start = new Date(start); this.end = new Date(end);
      this.description = options.description || ''; this.location = options.location || ''; this.allDay = allDay; this.tags = {}; this.deleted = false; this.recurring = false;
      assert.equal(options.guests, undefined, 'No guest list'); assert.equal(options.sendInvites || false, false, 'No invitations');
    }
    getId() { return this.id; }
    getTag(key) { return this.tags[key] || ''; }
    setTag(key, value) {
      if (injectedTagFailure && key === 'bridgeClient') { injectedTagFailure = false; throw new Error('Injected interruption'); }
      this.tags[key] = value; mutations++; return this;
    }
    getStartTime() { return new Date(this.start); }
    getDescription() { return this.description; }
    isRecurringEvent() { return this.recurring; }
    setTime(start, end) { this.start = new Date(start); this.end = new Date(end); this.allDay = false; mutations++; return this; }
    setAllDayDates(start, end) { this.start = new Date(start); this.end = new Date(end); this.allDay = true; mutations++; return this; }
    setTitle(value) { this.title = value; mutations++; return this; }
    setDescription(value) { this.description = value; mutations++; return this; }
    setLocation(value) { this.location = value; mutations++; return this; }
    deleteEvent() { this.deleted = true; mutations++; }
  }
  const calendar = {
    getName: () => 'Работа', getId: () => 'dedicated-calendar', setSelected: () => {},
    getEvents: (start, end) => events.filter(event => !event.deleted && event.end > start && event.start < end),
    getEventById: id => events.find(event => !event.deleted && event.id === id) || null,
    createEvent(title, start, end, options) { const event = new Event(title, start, end, options); events.push(event); mutations++; return event; },
    createAllDayEvent(title, start, end, options) { const event = new Event(title, start, end, options, true); events.push(event); mutations++; return event; }
  };
  const context = {
    console, Date, JSON, Set, Number, Object,
    PropertiesService: { getScriptProperties: () => props },
    CalendarApp: { getCalendarById: id => id === 'dedicated-calendar' ? calendar : null, createCalendar: () => calendar },
    LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: value => ({ value, setMimeType() { return this; } }) },
    Session: { getScriptTimeZone: () => scriptTimezone },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, getUuid: crypto.randomUUID,
      computeDigest: (_, value) => [...crypto.createHash('sha256').update(value).digest()],
      formatDate(date, zone) { return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); },
      parseDate(date, zone) {
        return new Date(date + (zone === 'Europe/Moscow' ? 'T00:00:00+03:00' : 'T00:00:00-07:00'));
      }
    },
    ScriptApp: { getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/test/exec' }) }, Logger: { log() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'GoogleCalendarBridge.gs'), 'utf8'), context);
  function send(data) { return JSON.parse(context.doPost({ postData: { contents: JSON.stringify(data) } }).value); }
  function payload(op, extra = {}) { return { version: 1, token, source: 'owa.example.com', clientId,
    timezone: 'Europe/Moscow', windowStart: '2026-10-01T00:00:00.000Z', windowEnd: '2026-12-01T00:00:00.000Z', complete: true, op, ...extra }; }
  function item(key = keyA, extra = {}) { return { key, title: 'Meeting', start: '2026-10-14T10:00:00.000Z', end: '2026-10-14T11:00:00.000Z', allDay: false, description: 'Call: https://meeting.example/123', location: 'Room 1', ...extra }; }
  return { context, send, payload, item, events, calendar, props, mutations: () => mutations,
    setTimezone: value => { scriptTimezone = value; }, interruptTag: () => { injectedTagFailure = true; } };
}

module.exports = { clientHarness, serverHarness, clientId, token, FixtureDate };

if (require.main === module) (async () => {
  await test('connection accepts only Apps Script HTTPS /exec + 64-character key', () => {
    const client = clientHarness();
    const valid = client.connection(`https://script.google.com/macros/s/deployment_123/exec#${token}`);
    assert.equal(valid.url, 'https://script.google.com/macros/s/deployment_123/exec'); assert.equal(valid.token, token);
    for (const value of ['http://script.google.com/macros/s/x/exec#'+token, 'https://evil.example/exec#'+token, 'https://script.google.com/macros/s/x/dev#'+token, 'https://script.google.com/macros/s/x/exec#short']) assert.throws(() => client.connection(value));
  });
  await test('Google login HTML is diagnosed even when HTTP status is 200', () => {
    const client=clientHarness();
    assert.throws(()=>client.googleResponse({status:200,finalUrl:'https://accounts.google.com/v3/signin/identifier?continue=PRIVATE_URL',responseText:'<html><title>Sign in - Google Accounts</title></html>'}),/Google требует входа/);
    assert.throws(()=>client.googleResponse({status:200,responseText:'<html><title>Sign in - Google Accounts</title></html>'}),/Google требует входа/);
    assert.throws(()=>client.googleResponse({status:403,responseText:'Forbidden'}),/Google запретил доступ/);
    assert.throws(()=>client.googleResponse({status:200,responseText:'Script function not found: doPost'}),/опубликованной версии нет doPost/);
    assert.equal(client.googleResponse({status:200,responseText:'{"ok":true,"version":1}'}).version,1);
    assert.throws(()=>client.googleResponse({status:200,responseText:'{"ok":false,"error":"Неверный ключ"}'}),/Неверный ключ/);
  });
  await test('UTC, explicit offset and Microsoft dates parse consistently', () => {
    const client = clientHarness();
    assert.equal(client.instant('2026-10-14T13:30:00+03:00'), '2026-10-14T10:30:00.000Z');
    assert.equal(client.instant('2026-10-14T10:30:00'), '2026-10-14T10:30:00.000Z');
    const ms = Date.parse('2026-10-14T10:30:00Z'); assert.equal(client.instant(`/Date(${ms}+0300)/`), '2026-10-14T10:30:00.000Z');
    assert.throws(() => client.instant('invalid'));
    assert.equal(client.dateInZone('2026-10-13T21:00:00Z','Europe/Moscow'),'2026-10-14');
  });
  await test('single-event moves keep identity; recurring instances stay distinct and exceptions stable', async () => {
    const client = clientHarness();
    const source = { ItemId: { Id: 'id-a' }, UID: 'series-or-single', Subject: 'Title', Start: '2026-10-14T10:00:00Z', End: '2026-10-14T11:00:00Z', CalendarItemType: 'Single', Body: {BodyType:'Text',Value:'A & B <script>'}, Location:'Room' };
    const a = await client.normalize(source);
    const moved = await client.normalize({...source, Start:'2026-10-15T10:00:00Z',End:'2026-10-15T11:00:00Z'});
    assert.equal(a.key,moved.key); assert.ok(a.description.includes('&lt;script&gt;'));
    const occurrence = await client.normalize({...source,CalendarItemType:'Occurrence'});
    const later = await client.normalize({...source,CalendarItemType:'Occurrence',Start:'2026-10-15T10:00:00Z',End:'2026-10-15T11:00:00Z'});
    const exception = await client.normalize({...source,CalendarItemType:'Exception',Start:'2026-10-15T10:00:00Z',End:'2026-10-15T11:00:00Z',OriginalStart:source.Start});
    assert.notEqual(occurrence.key,later.key);assert.equal(occurrence.key,exception.key);
  });
  await test('OWA requests use its actual CalendarPageView contract and same-origin credentials', async () => {
    let request;
    const client = clientHarness(async (url, init) => { request={url,init};return {ok:true,status:200,json:async()=>({Body:{ResponseMessages:{Items:[{ResponseCode:'NoError',ResponseClass:'Success',RootFolder:{Items:[],IncludesLastItemInRange:true,TotalItemsInView:0}}]}}})}; });
    const result = await client.findRange('2026-10-01T00:00:00Z','2026-10-08T00:00:00Z');
    assert.equal(result.complete,true);assert.equal(request.init.credentials,'same-origin');
    const body=JSON.parse(request.init.body);assert.equal(body.Body.Paging.__type,'CalendarPageView:#Exchange');assert.equal(body.Body.ParentFolderIds[0].Id,'calendar');assert.equal(body.Header.TimeZoneContext.TimeZoneDefinition.Id,'UTC');assert.equal(request.init.headers['X-OWA-CANARY'],'PRIVATE_CANARY');
  });
  await test('unknown completeness never authorizes removals; server-side truncation splits range', async () => {
    let calls=0;
    const client=clientHarness(async()=>({ok:true,status:200,json:async()=>({Body:{ResponseMessages:{Items:[{ResponseCode:'NoError',RootFolder:{Items:[],IncludesLastItemInRange:++calls===1?false:true}}]}}})}));
    const split=await client.findRange('2026-10-01T00:00:00Z','2026-10-08T00:00:00Z');assert.equal(calls,3);assert.equal(split.complete,true);
    const unknown=clientHarness(async()=>({ok:true,status:200,json:async()=>({Body:{ResponseMessages:{Items:[{ResponseCode:'NoError',RootFolder:{Items:[]}}]}}})}));
    assert.equal((await unknown.findRange('2026-10-01T00:00:00Z','2026-10-08T00:00:00Z')).complete,false);
  });
  await test('OWA errors and malformed calendar responses stop collection', async () => {
    const failed=clientHarness(async()=>({ok:true,status:200,json:async()=>({Body:{ResponseMessages:{Items:[{ResponseCode:'ErrorAccessDenied'}]}}})}));
    await assert.rejects(()=>failed.findRange('2026-10-01T00:00:00Z','2026-10-08T00:00:00Z'),/ErrorAccessDenied/);
    const malformed=clientHarness(async()=>({ok:true,status:200,json:async()=>({Body:{ResponseMessages:{Items:[{ResponseCode:'NoError',RootFolder:{Items:[{ItemId:{Id:'master'},CalendarItemType:'RecurringMaster',Start:'2026-01-01T00:00:00Z',End:'2026-01-01T01:00:00Z'}]}}]}}})}));
    await assert.rejects(()=>malformed.collect(),/шаблон серии/);
  });
  await test('full snapshot collects details and removes corporate identifiers from outbound events', async () => {
    const source={ItemId:{Id:'PRIVATE_EXCHANGE_ID'},UID:'PRIVATE_UID',Subject:'Actual title',Start:'2026-10-14T10:00:00Z',End:'2026-10-14T11:00:00Z',CalendarItemType:'Single'};
    const client=clientHarness(async(url)=>({ok:true,status:200,json:async()=>({Body:{ResponseMessages:{Items:[url.includes('FindItem')?{ResponseCode:'NoError',RootFolder:{Items:[source],IncludesLastItemInRange:true}}:{ResponseCode:'NoError',Items:[{...source,Body:{BodyType:'Text',Value:'Description with https://call.example'},Location:'Room'}]}]}}})}));
    const snapshot=await client.collect();
    const normalized=await client.normalize({...source,Body:{BodyType:'Text',Value:'Description with https://call.example'}});
    assert.ok(!JSON.stringify(normalized).includes('PRIVATE_EXCHANGE_ID'));assert.ok(!JSON.stringify(normalized).includes('PRIVATE_UID'));assert.ok(normalized.description.includes('https://call.example'));
    assert.equal(snapshot.complete,true);assert.equal(snapshot.events.length,1);assert.ok(snapshot.events[0].description.includes('https://call.example'));
  });
  await test('ICS folding counts UTF-8 bytes, not JS character count', () => {
    const client=clientHarness();const line='SUMMARY:'+ 'Длинное название '.repeat(20); const folded=client.fold(line);
    for(const part of folded.split('\r\n')) assert.ok(Buffer.byteLength(part,'utf8')<=75);
    assert.equal(folded.replace(/\r\n /g,''),line);
  });
  await test('invalid key and invalid batch cause zero Google mutations', () => {
    const server=serverHarness();const denied=server.send({...server.payload('upsert',{events:[server.item()]}),token:'wrong'});assert.equal(denied.ok,false);assert.equal(server.mutations(),0);
    const invalid=server.send(server.payload('upsert',{events:[server.item(),server.item(keyB,{end:'bad'})]}));assert.equal(invalid.ok,false);assert.equal(server.mutations(),0);
  });
  await test('setup exposes the existing connection key even without an /exec service URL', () => {
    for (const url of [null, 'https://script.google.com/macros/s/editor/ dev'.replace(' ', '')]) {
      const server=serverHarness();const logs=[];
      server.context.ScriptApp.getService=()=>({getUrl:()=>url});server.context.Logger.log=value=>logs.push(String(value));
      server.context.setup();assert.ok(logs.includes(token));assert.equal(server.props.getProperty('BRIDGE_TOKEN'),token);
      assert.ok(!logs.some(line=>line.includes('Затем снова запусти setup')));
    }
  });
  await test('connection key can be shown without a personal deployment URL in source', () => {
    const server=serverHarness();const logs=[];server.context.Logger.log=value=>logs.push(String(value));
    server.context.showConnectionKey();assert.ok(logs.includes(token));assert.equal(server.mutations(),0);
  });
  await test('connection key rotation preserves the calendar and revokes the old key', () => {
    const server=serverHarness();server.context.rotateConnectionKey();const rotated=server.props.getProperty('BRIDGE_TOKEN');
    assert.match(rotated,/^[a-f0-9]{64}$/);assert.notEqual(rotated,token);
    assert.equal(server.send(server.payload('ping')).ok,false);assert.equal(server.send({...server.payload('ping'),token:rotated}).ok,true);
    assert.equal(server.props.getProperty('BRIDGE_CALENDAR_ID'),'dedicated-calendar');assert.equal(server.mutations(),0);
  });
  await test('a client is bound to its first OWA host before subsequent writes', () => {
    const server=serverHarness();assert.equal(server.send(server.payload('upsert',{events:[server.item()]})).ok,true);
    const before=server.mutations();const switched=server.send({...server.payload('upsert',{events:[server.item(keyA,{title:'Changed'})]}),source:'other-owa.example.com'});
    assert.equal(switched.ok,false);assert.match(switched.error,/Конфликт источника/);assert.equal(server.mutations(),before);
    assert.equal(server.send({...server.payload('upsert',{events:[]}),source:'https://invalid.example/path'}).ok,false);
  });
  await test('repeated sync is idempotent and a moved event updates the existing copy', () => {
    const server=serverHarness();const initial=server.send(server.payload('upsert',{events:[server.item()]}));assert.equal(initial.created,1);
    const again=server.send(server.payload('upsert',{events:[server.item()]}));assert.equal(again.unchanged,1);assert.equal(server.events.length,1);
    const moved=server.send(server.payload('upsert',{events:[server.item(keyA,{title:'Moved',start:'2026-10-15T10:00:00.000Z',end:'2026-10-15T11:00:00.000Z'})]}));assert.equal(moved.updated,1);assert.equal(server.events.length,1);assert.equal(server.events[0].title,'Moved');
  });
  await test('a timeout between creation and tags recovers without duplicate', () => {
    const server=serverHarness();server.interruptTag();const first=server.send(server.payload('upsert',{events:[server.item()]}));assert.equal(first.ok,false);assert.equal(server.events.length,1);
    const recovered=server.send(server.payload('upsert',{events:[server.item()]}));assert.equal(recovered.ok,true);assert.equal(recovered.updated,1);assert.equal(server.events.length,1);assert.equal(server.events[0].getTag('bridgeKey'),keyA);
  });
  await test('partial snapshots cannot delete; finalize deletes only this client and this window', () => {
    const server=serverHarness();server.send(server.payload('upsert',{events:[server.item()]}));
    const unrelated=server.calendar.createEvent('Personal',new Date('2026-10-14T09:00:00Z'),new Date('2026-10-14T09:30:00Z'),{});
    const other=server.calendar.createEvent('Other client',new Date('2026-10-14T09:00:00Z'),new Date('2026-10-14T09:30:00Z'),{});other.setTag('bridge','owa-google-bridge-v1').setTag('bridgeClient','ffffffff-ffff-4fff-8fff-ffffffffffff').setTag('bridgeKey',keyB);
    const spanning=server.calendar.createEvent('Started before range',new Date('2026-09-30T23:00:00Z'),new Date('2026-10-01T01:00:00Z'),{});spanning.setTag('bridge','owa-google-bridge-v1').setTag('bridgeClient',clientId).setTag('bridgeKey','d'.repeat(64));
    const partial=server.send(server.payload('finalize',{keys:[],complete:false}));assert.equal(partial.ok,false);assert.equal(server.events[0].deleted,false);
    const finished=server.send(server.payload('finalize',{keys:[]}));assert.equal(finished.deleted,1);assert.equal(unrelated.deleted,false);assert.equal(other.deleted,false);assert.equal(spanning.deleted,false);
  });
  await test('all-day dates remain correct with a different Apps Script project timezone', () => {
    const server=serverHarness();server.setTimezone('America/Los_Angeles');
    const result=server.send(server.payload('upsert',{events:[server.item(keyA,{allDay:true,start:'2026-10-13T21:00:00.000Z',end:'2026-10-14T21:00:00.000Z',startDate:'2026-10-14',endDate:'2026-10-15'})]}));
    assert.equal(result.created,1);assert.equal(server.events[0].allDay,true);
    const date=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(server.events[0].start);assert.equal(date,'2026-10-14');
  });
  await test('ownership conflict is reported before mutation or deletion', () => {
    const server=serverHarness();server.send(server.payload('upsert',{events:[server.item()]}));
    server.events[0].tags.bridgeClient='ffffffff-ffff-4fff-8fff-ffffffffffff';server.events[0].description='No marker';
    const before=server.mutations();const result=server.send(server.payload('upsert',{events:[server.item(keyA,{title:'Changed'})]}));assert.equal(result.ok,false);assert.equal(server.mutations(),before);
  });
  await test('sharing audit detects personal endpoints and secrets, including embedded installer code', () => {
    const { scanText } = require('./audit-sharing.cjs');
    const personal = 'https://script.google.com/macros/s/' + 'X'.repeat(50) + '/exec';
    assert.ok(scanText('helper.gs',personal).some(finding=>finding.reason.includes('deployment')));
    const keyLink = '/exec#' + 'e'.repeat(64);
    assert.ok(scanText('config.txt',keyLink).length>0);
    const calendarUrl = '/owa/calendar/person@example.com/' + 'f'.repeat(60) + '/calendar.ics';
    assert.ok(scanText('notes.txt',calendarUrl).length>0);
    const encoded = Buffer.from(personal).toString('base64');
    const html = `const files={userscript:'${encoded}',receiver:'${Buffer.from('safe').toString('base64')}'};`;
    assert.ok(scanText('INSTALL.html',html).some(finding=>finding.file.includes('embedded')));
    const result=scanText('sample.js',"const token = 'a'.repeat(64); const host = 'owa.example.com';");assert.equal(result.length,0);
  });
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if(failures.length) process.exitCode=1;
})();
