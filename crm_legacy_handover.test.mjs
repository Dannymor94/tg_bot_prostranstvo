import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
function setup(){
 const props={WRITE_ENABLED:'true'},writes=[],triggers=[['bdOnSheetEdit','s'],['bdOnCalendarChange','c'],['bdTimer',null],['pollTelegram',null]].map(([handler,sourceId],i)=>({getHandlerFunction:()=>handler,getTriggerSourceId:()=>sourceId,getTriggerSource:()=>sourceId?'SERVICE':'CLOCK',getEventType:()=> 'TEST',getUniqueId:()=>String(i)}));
 const cfg={spreadsheetId:'s',calendarId:'c',writeEnabled:true},cal={accessRole:'owner',timeZone:'Europe/Moscow',summary:'ТЕСТ — Студия (GAS ↔ таблица)'};
 let title='ТЕСТ — old',locked=true;
 const p={getProperty:k=>props[k]??null,getKeys:()=>Object.keys(props),setProperty(k,v){writes.push(k);props[k]=v;}};
 const ctx=vm.createContext({config_:()=>cfg,BD:{testSpreadsheet:'s',testCalendar:'c'},PropertiesService:{getScriptProperties:()=>p},
  SpreadsheetApp:{openById:()=>({getName:()=>title,getSpreadsheetTimeZone:()=> 'Europe/Moscow'})},Calendar:{CalendarList:{get:()=>cal}},
  ScriptApp:{getProjectTriggers:()=>triggers.slice(),getScriptId:()=> 'old-test',deleteTrigger:t=>triggers.splice(triggers.indexOf(t),1)},
  LockService:{getScriptLock:()=>({tryLock:()=>locked,releaseLock(){}})},console:{log(){}}});
 vm.runInContext(readFileSync(new URL('scripts/legacy-test-handover.gs',import.meta.url),'utf8'),ctx);
 return {ctx,cfg,cal,props,triggers,writes,setTitle:v=>title=v,setLocked:v=>locked=v};
}
test('missing legacy checkpoint is permitted only alongside exact TEST isolation',()=>{
 const s=setup();assert.equal(s.ctx.legacyTestAudit().result.checkpointBinding,'absent_TEST_only');assert.equal(s.writes.length,0);
 s.cfg.spreadsheetId='production';assert.throws(()=>s.ctx.legacyTestAudit(),/exact legacy TEST/);assert.equal(s.writes.length,0);
});
test('nonempty wrong checkpoint, production approval and wrong Calendar owner fail before mutation',()=>{
 for(const change of [s=>s.props.BD_TARGET_BINDING='other|c',s=>s.props.BIDIR_PRODUCTION_APPROVED='s|c',s=>s.cal.accessRole='writer',s=>s.setTitle('Working production')]){
  const s=setup();change(s);assert.throws(()=>s.ctx.legacyStopTestBookingWriters());assert.equal(s.writes.length,0);assert.equal(s.triggers.length,4);
 }
});
test('pending transaction and busy lock prevent TEST writer shutdown',()=>{
 for(const change of [s=>s.props.BD_PENDING_date='pending',s=>s.setLocked(false)]){
  const s=setup();change(s);assert.throws(()=>s.ctx.legacyStopTestBookingWriters());assert.equal(s.writes.length,0);assert.equal(s.triggers.length,4);
 }
});
test('verified shutdown archives configuration and removes booking writers only',()=>{
 const s=setup(),result=s.ctx.legacyStopTestBookingWriters();assert.equal(result.stopped,true);
 assert.deepEqual(s.triggers.map(t=>t.getHandlerFunction()),['pollTelegram']);assert.equal(s.props.BIDIR_PAUSED,'true');
 assert.equal(JSON.parse(s.props.LEGACY_TEST_TRIGGER_ARCHIVE).triggers.length,4);
 assert.equal(JSON.parse(s.props.LEGACY_TEST_HANDOVER).scriptId,'old-test');assert.equal(s.props.WRITE_ENABLED,'true');
});
test('trigger attached to another Sheet or unknown handler is not deleted',()=>{
 const s=setup();s.triggers[0].getTriggerSourceId=()=> 'production';assert.throws(()=>s.ctx.legacyStopTestBookingWriters(),/binding differs/);assert.equal(s.writes.length,0);
 const other=setup();other.triggers[0].getHandlerFunction=()=> 'unrelated';assert.throws(()=>other.ctx.legacyStopTestBookingWriters(),/Unknown/);assert.equal(other.triggers.length,4);
});
