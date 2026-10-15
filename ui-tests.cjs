const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JSDOM } = require('jsdom');
const { serverHarness, clientId, token, FixtureDate } = require('./tests.cjs');
const source = fs.readFileSync(path.join(__dirname, 'owa-google-sync.user.js'), 'utf8');
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
async function settle(check) {
  for(let i=0;i<100;i++) { if(check()) return; await pause(); }
  throw new Error('UI did not settle');
}

function fixture(configured = true) {
  const dom = new JSDOM('<!doctype html><html><body><h1>Имитация OWA</h1></body></html>', {url:'https://owa.example.com/owa/',runScripts:'outside-only'});
  const { window } = dom;
  const server = serverHarness();
  const googleRequests=[];
  const sourceItem={ItemId:{Id:'PRIVATE_EXCHANGE_ID'},UID:'PRIVATE_SERIES_UID',Subject:'Планирование команды',Start:'2026-10-15T10:00:00Z',End:'2026-10-15T11:00:00Z',CalendarItemType:'Single'};
  const data = { active:true, failed:false, malformed:false, root:null, storage:{clientId,connection:configured?`https://script.google.com/macros/s/local_fixture/exec#${token}`:'',pastDays:7,futureDays:60,timezone:'Europe/Moscow'} };
  Object.defineProperty(window,'crypto',{value:crypto.webcrypto});window.TextEncoder=TextEncoder;window.Date=FixtureDate;
  window.GM_getValue=()=>data.storage;window.GM_setValue=(_,value)=>{data.storage=value;};window.GM_registerMenuCommand=()=>{};
  window.GM_xmlhttpRequest=options=>{const payload=JSON.parse(options.data);googleRequests.push(payload);queueMicrotask(()=>options.onload({responseText:JSON.stringify(server.send(payload))}));};
  const originalAttach=window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow=function(options){const root=originalAttach.call(this,options);data.root=root;return root;};
  window.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
  window.document.cookie='X-OWA-CANARY=PRIVATE_CANARY';
  window.fetch=async(url,options)=>{
    if(data.failed)return{ok:false,status:403};
    const request=JSON.parse(options.body);const find=url.includes('FindItem');
    const start=Date.parse(request.Body.Paging?.StartDate||'2026-10-01T00:00:00Z');const end=Date.parse(request.Body.Paging?.EndDate||'2026-12-01T00:00:00Z');
    const items=data.active && Date.parse(sourceItem.End)>start && Date.parse(sourceItem.Start)<end?[sourceItem]:[];
    const detail={...sourceItem,Body:{BodyType:'HTML',Value:'<div>Обсудить <b>планы</b></div><p><a href="https://call.example/room?id=1&amp;k=2">Подключиться</a></p><script>throw new Error("must not execute")</script><img src="https://tracking.invalid/pixel">'},Location:'Переговорная 4'};
    return{ok:true,status:200,json:async()=>({Body:{ResponseMessages:{Items:[find?{ResponseCode:'NoError',RootFolder:{Items:items,IncludesLastItemInRange:true}}:{ResponseCode:data.malformed?'ErrorItemNotFound':'NoError',Items:[detail]}]}}})};
  };
  window.eval(source);
  return {dom,window,server,data,googleRequests,get:id=>data.root.getElementById(id),close:()=>window.close()};
}

(async()=>{
  const ui=fixture();
  try {
    assert.equal(ui.get('sync').textContent,'Синхронизировать');assert.equal(ui.get('dialog').hasAttribute('open'),false);
    ui.get('settings').click();assert.equal(ui.get('dialog').hasAttribute('open'),true);ui.get('cancel').click();assert.equal(ui.get('dialog').hasAttribute('open'),false);
    ui.get('collapse').click();assert.equal(ui.get('content').hidden,true);ui.get('collapse').click();assert.equal(ui.get('content').hidden,false);
    console.log('PASS panel, settings and collapse controls');
    ui.get('preview').click();await settle(()=>!ui.get('preview').disabled);
    assert.ok(ui.get('status').textContent.includes('Прочитано 1'));assert.ok(ui.get('list').textContent.includes('Планирование команды'));assert.equal(ui.googleRequests.length,0);
    console.log('PASS preview reads full calendar without Google writes');
    ui.get('sync').click();await settle(()=>!ui.get('sync').disabled);
    assert.ok(ui.get('status').textContent.startsWith('Готово:'),ui.get('status').textContent);assert.equal(ui.server.events.length,1);
    const sent=ui.googleRequests.find(request=>request.op==='upsert').events[0];
    assert.ok(sent.description.includes('https://call.example/room?id=1&amp;k=2'));assert.ok(sent.description.includes('Обсудить планы'));assert.ok(!sent.description.includes('must not execute'));assert.ok(!sent.description.includes('tracking.invalid'));
    assert.ok(!JSON.stringify(ui.googleRequests).includes('PRIVATE_CANARY'));assert.ok(!JSON.stringify(ui.googleRequests).includes('PRIVATE_EXCHANGE_ID'));assert.ok(!JSON.stringify(ui.googleRequests).includes('PRIVATE_SERIES_UID'));
    console.log('PASS sync click → OWA details → Google receiver; links preserved, source identifiers excluded');
    ui.get('sync').click();await settle(()=>!ui.get('sync').disabled);assert.equal(ui.server.events.length,1);assert.ok(ui.get('status').textContent.includes('без изменений 1'));
    console.log('PASS repeated UI sync has no duplicates');
    const writesBefore=ui.server.mutations();ui.data.failed=true;const count=ui.googleRequests.length;
    ui.get('sync').click();await settle(()=>!ui.get('sync').disabled);assert.equal(ui.server.mutations(),writesBefore);assert.equal(ui.googleRequests.slice(count).filter(request=>request.op!=='ping').length,0);assert.ok(ui.get('status').textContent.includes('OWA отклонил'));
    console.log('PASS failed source blocks uploads and deletion');
    ui.data.failed=false;ui.data.active=false;ui.get('sync').click();await settle(()=>!ui.get('sync').disabled);assert.equal(ui.server.events[0].deleted,true);assert.ok(ui.get('status').textContent.includes('удалено 1'));
    console.log('PASS source cancellation removes copy after a successful complete sync');
  }finally{ui.close();}
  const initial=fixture(false);
  try{
    initial.get('sync').click();assert.equal(initial.get('dialog').hasAttribute('open'),true);assert.equal(initial.googleRequests.length,0);
    initial.get('connection').value='https://evil.example';initial.get('save').click();assert.ok(initial.get('error').textContent);assert.equal(initial.get('dialog').hasAttribute('open'),true);
    initial.get('connection').value=`https://script.google.com/macros/s/local_fixture/exec#${token}`;initial.get('save').click();assert.equal(initial.get('dialog').hasAttribute('open'),false);assert.ok(initial.data.storage.connection.includes('/exec#'));
    console.log('PASS first-use settings validates and saves one connection link');
  }finally{initial.close();}
  const guide=new JSDOM(fs.readFileSync(path.join(__dirname,'INSTALL.html'),'utf8'),{url:'file:///installation/INSTALL.html',runScripts:'dangerously',beforeParse(window){window.TextDecoder=TextDecoder;}});
  try{
    assert.equal(guide.window.document.getElementById('userscript').value,source);assert.equal(guide.window.document.getElementById('receiver').value,fs.readFileSync(path.join(__dirname,'GoogleCalendarBridge.gs'),'utf8'));
    guide.window.document.execCommand=()=>true;
    guide.window.document.querySelector('[data-copy="userscript"]').click();await pause();assert.ok(guide.window.document.getElementById('toast').textContent.includes('Сначала укажите адрес'));
    const address=guide.window.document.getElementById('owa-address');
    const enter=value=>{address.value=value;address.dispatchEvent(new guide.window.Event('input',{bubbles:true}));};
    enter('https://mail.team.example.com/owa/#path=/calendar');
    const prepared=guide.window.document.getElementById('userscript').value;
    assert.ok(prepared.includes('// @match        https://mail.team.example.com/owa/*'));
    assert.ok(prepared.includes('// @exclude      https://mail.team.example.com/owa/calendar/*'));
    assert.ok(!prepared.includes('// @match        https://*/owa/*'));
    assert.ok(!prepared.includes('#path=/calendar'));
    guide.window.document.querySelector('[data-copy="userscript"]').click();await pause();assert.ok(guide.window.document.getElementById('toast').textContent.includes('Код скопирован'));
    console.log('PASS installation artifact contains exact current scripts');
    console.log('PASS installer requires OWA address and restricts script matching to that host');
    for(const value of ['http://owa.example.com/owa/','https://owa.example.com/owa/calendar/published/calendar.html','https://outlook.office.com/mail/','https://user:pass@owa.example.com/owa/']){
      enter(value);assert.ok(guide.window.document.getElementById('owa-hint').classList.contains('error'));
      assert.equal(guide.window.document.getElementById('userscript').value,source);
    }
    enter('https://owa.example.com/');assert.ok(guide.window.document.getElementById('userscript').value.includes('// @match        https://owa.example.com/owa/*'));
    console.log('PASS installer rejects unsafe or unsupported addresses and resets stale prepared code');
  }finally{guide.window.close();}
  console.log('\n10 UI/installation checks passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
