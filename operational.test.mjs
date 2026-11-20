import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sources = ['Code.gs', 'Bidirectional.gs', 'TelegramUX.gs']
  .map(name => fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8'));

function fixture() {
  const values = new Map([
    ['WRITE_ENABLED', 'true'], ['BIDIR_ACTIVE', 'true'],
  ]);
  const props = {
    getProperty: key => values.get(key) ?? null,
    setProperty: (key, value) => values.set(key, String(value)),
    deleteProperty: key => values.delete(key),
    getProperties: () => Object.fromEntries(values),
  };
  const ctx = vm.createContext({
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: { formatDate: (date, _tz, format) => {
      const p = n => String(n).padStart(2, '0');
      if (format === 'HH:mm') return `${p(date.getHours())}:${p(date.getMinutes())}`;
      if (format === 'dd.MM HH:mm') return `${p(date.getDate())}.${p(date.getMonth()+1)} ${p(date.getHours())}:${p(date.getMinutes())}`;
      return `${date.getFullYear()}-${p(date.getMonth()+1)}-${p(date.getDate())}`;
    } },
    Logger: { log: () => {} },
  });
  sources.forEach(code => vm.runInContext(code, ctx));
  const run = expr => vm.runInContext(expr, ctx);
  ctx.config_ = () => ({
    spreadsheetId: '1FNufCunHlY5m4HAzBnRcZKRJtM7YfKKHcDehN8SGUxo',
    calendarId: '48dcda42a1404258847154571d9d674473f8580900e3fd5e7b6ca049cbc863b8@group.calendar.google.com',
    ownerChatId: '', telegramToken: 'not-a-real-token',
  });
  return { ctx, run, props, values };
}

test('Calendar full-scan fallback is atomic across a conflicting cross-day move', () => {
  const { ctx, run, values } = fixture();
  const [oldKey, newKey] = JSON.parse(JSON.stringify(run('bdDates_(localDay_(new Date()),2)')));
  const oldCells = Array(16).fill(''); oldCells[9] = 'Марина';
  const newCells = Array(16).fill(''); newCells[9] = 'Ольга';
  const oldStart = run(`localDateFromKey_('${oldKey}').getTime()`);
  const newStart = run(`localDateFromKey_('${newKey}').getTime()`);
  const priorEvent = { id:'event-1', title:'Марина', start:oldStart+15*3600000, end:oldStart+16*3600000 };
  const newEvent = { ...priorEvent, start:newStart+15*3600000, end:newStart+16*3600000 };
  values.set('BD_STATE_'+oldKey, JSON.stringify({ cells:oldCells, events:[priorEvent] }));
  ctx.bdReadDays_ = () => ({ [oldKey]:{row:10,cells:oldCells}, [newKey]:{row:11,cells:newCells} });
  ctx.bdCalendarDays_ = () => ({ grouped:{ [oldKey]:[], [newKey]:[{meta:newEvent}] }, unsupported:[] });
  ctx.sheet_ = () => ({});
  ctx.calendar_ = () => ({});
  let preflights=0;
  ctx.bdPreflightDay_ = () => {preflights++;};
  ctx.bdAudit_ = () => {throw Error('No writes expected');};
  const report = run(`bdReconcile_('calendar-edit',['${oldKey}','${newKey}'])`);
  assert.equal(report.applied, false);
  assert.match(report.conflicts.join(' '), /independently/);
  assert.equal(preflights, 0, 'must not clear the old date before checking new date');
  assert.equal(values.has('BD_PENDING_'+oldKey), false);
});

test('Calendar trigger falls back only when delta reading failed before writes', () => {
  const { ctx, run } = fixture();
  const calls=[];
  ctx.bdReconcile_ = mode => {
    calls.push(mode);
    if (mode==='calendar-delta') {
      const error=Error('API unavailable');error.calendarDeltaUnavailable=true;throw error;
    }
    return {applied:true};
  };
  assert.equal(run('bdOnCalendarChange()').applied, true);
  assert.deepEqual(calls,['calendar-delta','calendar-edit']);

  calls.length=0;
  let failures=0;
  ctx.bdRecordFailure_=() => {failures++;};
  ctx.bdReconcile_=mode=> {calls.push(mode);throw Error('post-write failure');};
  assert.throws(()=>run('bdOnCalendarChange()'),/post-write failure/);
  assert.deepEqual(calls,['calendar-delta']);
  assert.equal(failures,1);
});

test('timer and Sheet trigger record errors without swallowing the failed execution', () => {
  const { ctx, run } = fixture();
  let failures=[];
  ctx.bdRecordFailure_=(mode,error)=> failures.push([mode,error.message]);
  ctx.bdReconcile_=()=>{throw Error('failed sync');};
  assert.throws(()=>run('bdTimer()'),/failed sync/);
  const key=run('dayKey_(new Date())');
  const date=run(`localDateFromKey_('${key}')`);
  ctx.edit={source:{getId:()=>ctx.config_().spreadsheetId},range:{
    getSheet:()=>({getName:()=> 'Бронирование',getRange:()=>({getValues:()=>[[date]]})}),
    getLastColumn:()=>2,getColumn:()=>2,getLastRow:()=>6,getRow:()=>6,
  }};
  assert.throws(()=>run('bdOnSheetEdit(edit)'),/failed sync/);
  assert.deepEqual(failures.map(x=>x[0]),['timer','sheet-edit']);
});

test('operational alarm is owner-only, rate-limited, and hides event details', () => {
  const { ctx, run, values } = fixture();
  ctx.config_ = () => ({ownerChatId:'123',telegramToken:'not-a-real-token'});
  let alerts=[];
  ctx.sendTelegram_=(_token,chat,text)=> alerts.push([chat,text]);
  run("bdRecordFailure_('timer',Error('private person name'))");
  run("bdRecordFailure_('timer',Error('private person name'))");
  assert.equal(alerts.length,1);
  assert.equal(alerts[0][0],'123');
  assert.doesNotMatch(alerts[0][1],/private person name/);
  assert.equal(JSON.parse(values.get('BD_LAST_ERROR')).type,'execution_failed');
  values.set('BD_ALERT_AT',String(Date.now()-7*3600000));
  run("bdRecordFailure_('timer',Error('another failure'))");
  assert.equal(alerts.length,2);
});

test('Telegram conflict alert outage does not abort reconciliation', () => {
  const { ctx, run, values } = fixture();
  ctx.config_ = () => ({ownerChatId:'123',telegramToken:'not-a-real-token'});
  ctx.sendTelegram_=()=>{throw Error('Telegram outage');};
  ctx.testCfg={ownerChatId:'123',telegramToken:'fake'};
  assert.doesNotThrow(()=>run("alertOnChangedConflict_(testCfg,['2026-11-21: occupied'])"));
  assert.equal(values.has('LAST_CONFLICT'),false);
});

test('owner status shows latest unresolved failure and clears it after a successful reconciliation', () => {
  const { ctx, run, values } = fixture();
  ctx.config_ = () => ({ownerChatId:'123'});
  const now=Date.now();
  values.set('BD_LAST_SYNC',JSON.stringify({at:new Date(now-60000).toISOString(),mode:'timer',days:2,conflicts:0}));
  values.set('BD_LAST_ERROR',JSON.stringify({at:new Date(now-10000).toISOString(),mode:'calendar-edit'}));
  assert.match(run('tgUxStatus_(123)').text,/⚠️ после последней сверки \(calendar-edit\)/);
  values.set('BD_LAST_SYNC',JSON.stringify({at:new Date(now+1000).toISOString(),mode:'timer',days:2,conflicts:0}));
  assert.match(run('tgUxStatus_(123)').text,/Последняя ошибка: нет новых/);
  assert.doesNotMatch(run('tgUxStatus_(999)').text,/Последняя ошибка:/);
});
