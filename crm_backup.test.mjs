import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const ctx=vm.createContext({
 Utilities:{DigestAlgorithm:{SHA_256:'sha'},Charset:{UTF_8:'utf8'},computeDigest:(_a,s)=>[...createHash('sha256').update(s).digest()].map(x=>x>127?x-256:x)},
 DriveApp:{Access:{PRIVATE:'private'}}
});
for(const f of ['CrmCore.gs','CrmBackup.gs'])vm.runInContext(readFileSync(new URL(f,import.meta.url),'utf8'),ctx);
const {crmBackupState_:state,crmBackupRetention_:retention,crmBackupPayload_:payload,crmBackupWorkbookDigest_:digest,crmBackupPrivate_:privateOnly}=ctx;
const plain=x=>JSON.parse(JSON.stringify(x));
test('operational backup includes only required idempotency state, never tokens or binding',()=>{
 const p={TELEGRAM_TOKEN:'secret',CRM_V2_TEST_TELEGRAM_TOKEN:'secret2',CRM_V2_BINDING:'private',OWNER_CHAT_ID:'42',CRM_TG_UI_42:'screen',CRM_TG_CMD_123:'command',TG_OUTBOX_456:'reply',TG_OFFSET:'457',CRM_V2_SCAN_AFTER:'b1'};
 assert.deepEqual(plain(state(p)),{CRM_TG_CMD_123:'command',CRM_V2_SCAN_AFTER:'b1',TG_OFFSET:'457',TG_OUTBOX_456:'reply'});
});
test('retention keeps latest 14 available daily dates plus one per month, no duplicate dates',()=>{
 const dates=Array.from({length:45},(_,i)=>new Date(Date.UTC(2026,10,25-i)).toISOString().slice(0,10));
 dates.push('2026-01-20','2026-01-01','2025-12-25','2025-11-25',dates[0]);
 const r=retention(dates,'2026-11-25');
 for(const d of dates.slice(0,14))assert.ok(r.keep.includes(d));
 assert.ok(r.keep.includes('2026-01-20'));assert.ok(r.eligible.includes('2026-01-01'));
 assert.equal(r.keep.length+r.eligible.length,new Set(dates).size);
 assert.throws(()=>retention(['2026-11-26'],'2026-11-25'));
});
const snap=()=>({schema:1,date:'2026-11-25',spreadsheetId:'test-sheet',calendarId:'test-cal',timeZone:'Europe/Moscow',events:[{id:'e1',status:'cancelled'},{id:'e2',recurrence:['RRULE:FREQ=WEEKLY']}],state:{TG_OFFSET:'42'}});
test('payload preserves event tombstones and recurrence and rejects credentials or duplicates',()=>{
 assert.deepEqual(JSON.parse(payload(snap())),snap());
 assert.throws(()=>payload({...snap(),calendarId:'primary'}));
 assert.throws(()=>payload({...snap(),state:{TELEGRAM_TOKEN:'secret'}}));
 assert.throws(()=>payload({...snap(),events:[{id:'e1'},{id:'e1'}]}));
});
const book=(v,f='')=>({getSheets:()=>[{getName:()=> 'Sheet',getDataRange:()=>({getValues:()=>[[v]],getFormulas:()=>[[f]]})}]});
test('workbook hash detects literal or formula changes, ignores volatile calculated value',()=>{
 assert.notEqual(digest(book(1)),digest(book(2)));
 assert.notEqual(digest(book(1,'=1')),digest(book(1,'=2')));
 assert.equal(digest(book(1,'=NOW()')),digest(book(2,'=NOW()')));
 assert.match(digest(book(1)),/^[a-f0-9]{64}$/);
});
test('private destination guard rejects shared editors or viewers',()=>{
 const base={getSharingAccess:()=> 'private',getEditors:()=>[],getViewers:()=>[],getOwner:()=>({})};
 assert.doesNotThrow(()=>privateOnly(base));
 assert.throws(()=>privateOnly({...base,getSharingAccess:()=> 'anyone'}));
 assert.throws(()=>privateOnly({...base,getEditors:()=>[{}]}));
 assert.throws(()=>privateOnly({...base,getViewers:()=>[{}]}));
 assert.throws(()=>privateOnly({...base,getOwner:()=>null}));
});
