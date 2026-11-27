import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const ctx=vm.createContext({});
for(const f of ['CrmCore.gs','CrmRegistry.gs','CrmSync.gs','CrmSheets.gs','CrmCalendar.gs','CrmIntake.gs','CrmIntakeRuntime.gs','CrmMigration.gs'])vm.runInContext(readFileSync(new URL(f,import.meta.url),'utf8'),ctx);
const copy=x=>JSON.parse(JSON.stringify(x));
const profiles=[{id:'t1',name:'Synthetic tenant',direction:'Synthetic lesson',format:'group',regular:false}];
const event=()=>({id:'legacy123',etag:'"e1"',summary:'Synthetic tenant',status:'confirmed',description:ctx.crmLegacyMarker_(),
 start:{dateTime:'2026-11-27T18:30:00+03:00'},end:{dateTime:'2026-11-27T20:00:00+03:00'},
 colorId:'3',reminders:{useDefault:false,overrides:[{method:'popup',minutes:20}]},extendedProperties:{private:{other:'keep'},shared:{external:'keep'}}});
const approved=e=>({schema:1,approved:true,eventId:e.id,etag:e.etag,description:e.description,
 booking:copy(ctx.crmManualCalendarPlan_(e,profiles,ctx.crmDefaultTariff_(),'ext_'+e.id).booking)});
function fake(e=event()){
 let current=copy(e),patches=0;const calls=[];
 return {get current(){return current;},get patches(){return patches;},calls,
  request(method,path,body,headers){calls.push(method);if(method==='GET')return {code:200,body:copy(current)};
   assert.equal(method,'PATCH');assert.equal(headers['If-Match'],e.etag);
   assert.equal(body.id,undefined);assert.equal(body.start,undefined);assert.equal(body.end,undefined);
   assert.equal(body.colorId,undefined);assert.equal(body.reminders,undefined);
   current={...current,...copy(body),etag:'"e2"'};patches++;return {code:200,body:copy(current)};
  }
 };
}
test('legacy marker stays refused on ordinary automatic intake',()=>{
 const r=ctx.crmAdoptCalendarEvent_(()=>assert.fail('request'),'test',event(),profiles,ctx.crmDefaultTariff_());
 assert.equal(r.reason,'existing_description');
});
test('explicit legacy adoption preserves ID, interval, reminders, color, shared metadata and original description',()=>{
 const e=event(),p=fake(e),result=ctx.crmAdoptCalendarEvent_(p.request,'test',e,profiles,ctx.crmDefaultTariff_(),approved(e));
 assert.equal(result.booking.id,'ext_legacy123');assert.equal(p.current.id,e.id);
 assert.deepEqual(p.current.start,e.start);assert.deepEqual(p.current.end,e.end);
 assert.deepEqual(p.current.reminders,e.reminders);assert.equal(p.current.colorId,e.colorId);
 assert.equal(p.current.extendedProperties.private.crmLegacyDescription,e.description);
 assert.equal(p.current.extendedProperties.private.other,'keep');assert.deepEqual(p.current.extendedProperties.shared,e.extendedProperties.shared);
 assert.equal(p.calls.includes('POST'),false);assert.equal(p.calls.includes('DELETE'),false);
 assert.equal(ctx.crmAdoptCalendarEvent_(p.request,'test',e,profiles,ctx.crmDefaultTariff_(),approved(e)).replayed,true);
 assert.equal(p.patches,1);
});
test('ambiguous response after metadata patch replays from original durable snapshot',()=>{
 const e=event(),p=fake(e);let fail=true;
 const request=(...a)=>{const result=p.request(...a);if(a[0]==='PATCH'&&fail){fail=false;throw Error('lost response');}return result;};
 assert.throws(()=>ctx.crmAdoptCalendarEvent_(request,'test',e,profiles,ctx.crmDefaultTariff_(),approved(e)),/lost/);
 assert.equal(ctx.crmAdoptCalendarEvent_(request,'test',e,profiles,ctx.crmDefaultTariff_(),approved(e)).replayed,true);
 assert.equal(p.patches,1);
});
test('marker substring, trailing notes, wrong approval and changed snapshot cannot authorize a patch',()=>{
 for(const d of ['[STUDIO_BIDIR_V1]',ctx.crmLegacyMarker_()+' notes','notes '+ctx.crmLegacyMarker_()]){
  const e={...event(),description:d},p=fake(e);
  assert.throws(()=>ctx.crmAdoptCalendarEvent_(p.request,'test',e,profiles,ctx.crmDefaultTariff_(),approved(e)));
  assert.equal(p.patches,0);
 }
 const e=event();for(const change of [{approved:false},{eventId:'other'},{etag:'other'},{booking:{...approved(e).booking,to:1260}},{booking:{...approved(e).booking,direction:'Unapproved'}}]){
  const p=fake(e);assert.throws(()=>ctx.crmAdoptCalendarEvent_(p.request,'test',e,profiles,ctx.crmDefaultTariff_(),{...approved(e),...change}));assert.equal(p.patches,0);
 }
 const p=fake({...e,description:'changed without etag'});
 assert.throws(()=>ctx.crmAdoptCalendarEvent_(p.request,'test',e,profiles,ctx.crmDefaultTariff_(),approved(e)),/changed/);assert.equal(p.patches,0);
});
test('412, missing provenance and unsupported event require review or error without event creation',()=>{
 const e=event();const p=fake({...e,etag:'other'});
 assert.throws(()=>ctx.crmAdoptCalendarEvent_(p.request,'test',e,profiles,ctx.crmDefaultTariff_(),approved(e)),/changed/);assert.equal(p.patches,0);
 const request=(m)=>m==='GET'?{code:200,body:e}:{code:412};
 assert.throws(()=>ctx.crmAdoptCalendarEvent_(request,'test',e,profiles,ctx.crmDefaultTariff_(),approved(e)),/412/);
 const recurring={...e,recurrence:['RRULE:FREQ=WEEKLY']};
 assert.equal(ctx.crmAdoptCalendarEvent_(()=>assert.fail('write'),'test',recurring,profiles,ctx.crmDefaultTariff_(),approved(e)).kind,'review');
 const migrated=fake(e);ctx.crmAdoptCalendarEvent_(migrated.request,'test',e,profiles,ctx.crmDefaultTariff_(),approved(e));
 delete migrated.current.extendedProperties.private.crmLegacyDescription;
 assert.throws(()=>ctx.crmAdoptCalendarEvent_(migrated.request,'test',e,profiles,ctx.crmDefaultTariff_(),approved(e)),/provenance/);
});
test('missing tenant details stays on review; no guessed direction or format',()=>{
 const e=event(),p=fake(e),r=ctx.crmAdoptCalendarEvent_(p.request,'test',e,[{...profiles[0],format:null,direction:''}],ctx.crmDefaultTariff_(),approved(e));
 assert.equal(r.reason,'missing_booking_details');assert.equal(p.patches,0);
});
test('canonical comparison ignores JSON property order, not event content',()=>{
 assert.equal(ctx.crmMigrationCanonical_({b:{y:2,x:1},a:[]}),ctx.crmMigrationCanonical_({a:[],b:{x:1,y:2}}));
 assert.notEqual(ctx.crmMigrationCanonical_({a:1}),ctx.crmMigrationCanonical_({a:2}));
});
function archive(){
 const data=[copy(ctx.crmMigrationHeaders_())],s={data,formula:false};
 s.getName=()=> '_CRM_MIGRATION';s.getLastColumn=()=>5;s.getLastRow=()=>data.length;
 s.getRange=(r,c,n,m)=>({getValues:()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>data[r-1+i]?.[c-1+j]??'')),
  getFormulas:()=>Array.from({length:n},()=>Array(m).fill(s.formula?'=1':'')),
  setValues(rows){for(let i=0;i<rows.length;i++)data[r-1+i]=copy(rows[i]);}});
 return s;
}
test('migration archive preserves full raw event and rejects duplicate IDs and formulas',()=>{
 const s=archive(),e=event(),values=[e.id,'REVIEW',JSON.stringify(e),'','missing_details'];
 ctx.crmMigrationSet_(s,{row:2,values:Array(5).fill('')},values,()=>{});
 assert.deepEqual(copy(ctx.crmMigrationRows_(s)[0].event),e);
 s.data.push(copy(values));assert.throws(()=>ctx.crmMigrationRows_(s),/Invalid migration row/);s.data.pop();
 s.formula=true;assert.throws(()=>ctx.crmMigrationRows_(s),/schema/);
});
test('staging rejects changed source row and verifies ambiguous write before retry',()=>{
 const s=archive(),e=event(),values=[e.id,'REVIEW',JSON.stringify(e),'','review'];
 assert.throws(()=>ctx.crmMigrationSet_(s,{row:2,values:Array(5).fill('')},values,()=>{throw Error('flush failed');}));
 assert.equal(ctx.crmMigrationRows_(s).length,1);
 assert.throws(()=>ctx.crmMigrationSet_(s,{row:2,values:Array(5).fill('')},values,()=>{}),/changed/);
 assert.equal(s.data.length,2);
});
test('migration requires both verified same-target handover and fresh post-handover backup',()=>{
 const binding={mode:'TEST',spreadsheetId:'sheet',calendarId:'test'};
 const handover={mode:'TEST',stopped:true,at:'2026-11-26T08:00:00Z',scriptId:'old',...binding};
 const p={CRM_V2_BINDING:JSON.stringify(binding),CRM_V2_LEGACY_HANDOVER:JSON.stringify(handover),CRM_V2_MIGRATION_TEST_ENABLED:'true',CRM_V2_BACKUP_FOLDER_ID:'folder',
  CRM_V2_LAST_BACKUP:JSON.stringify({date:'2026-11-26',at:'2026-11-26T08:01:00Z',folderId:'folder',manifestId:'manifest'})};
 ctx.Utilities={formatDate:()=> '2026-11-26'};ctx.DriveApp={getFolderById:id=>id};
 ctx.crmBackupVerify_=(folder,id,b)=>{assert.equal(folder,'folder');assert.equal(id,'manifest');assert.equal(b.calendarId,'test');return {verified:true};};
 const env={props:{getProperty:k=>p[k]??null}};
 assert.equal(ctx.crmMigrationGuard_(env).verified,true);
 for(const override of [{CRM_V2_MIGRATION_TEST_ENABLED:'false'},{CRM_V2_LEGACY_HANDOVER:'null'},
  {CRM_V2_LEGACY_HANDOVER:JSON.stringify({...handover,calendarId:'production'})},
  {CRM_V2_LAST_BACKUP:JSON.stringify({date:'2026-11-26',at:'2026-11-26T07:00:00Z',folderId:'folder'})}]){
  const changed={...p,...override};assert.throws(()=>ctx.crmMigrationGuard_({props:{getProperty:k=>changed[k]??null}}));
 }
});

function projectionFixture(){
 const booking=approved(event()).booking;
 const values=Array(17).fill('');
 values.splice(0,6,46353,booking.from/1440,booking.to/1440,'Synthetic tenant',booking.direction,'Групповое');
 values[9]='Подтверждена';values[11]=booking.id;values[16]=booking.tenantId;
 function mock(name,data){
  const sheet={data,writes:[]};
  sheet.getName=()=>name;sheet.getLastColumn=()=>data[0].length;sheet.getLastRow=()=>data.length;
  sheet.getRange=(r,c,n,m)=>({
   getValues:()=>Array.from({length:n},(_,i)=>data[r-1+i].slice(c-1,c-1+m)),
   getDisplayValues:()=>Array.from({length:n},(_,i)=>data[r-1+i].map((v,j)=>name==='Аренды'&&r+i===2&&j<3?['27.11.2026','18:30','20:00'][j]:String(v)).slice(c-1,c-1+m)),
   getFormulas:()=>Array.from({length:n},()=>Array(m).fill('')),
   setValues(rows){sheet.writes.push([r,c,n,m]);for(let i=0;i<n;i++)for(let j=0;j<m;j++)data[r-1+i][c-1+j]=rows[i][j];}
  });return sheet;
 }
 const h=ctx.crmSheetHeaders_();
 return {booking,sheet:mock('Аренды',[copy(h['Аренды']),values]),tenantSheet:mock('Арендаторы',[copy(h['Арендаторы']),['Synthetic tenant','Synthetic lesson','Групповое',false,'','','','t1']])};
}
test('legacy ID projection writes only Calendar ID, preserves finance and replays without another write',()=>{
 const {booking,sheet,tenantSheet}=projectionFixture(),before=copy(sheet.data[1]);
 assert.equal(ctx.crmMigrationProjectCalendarId_(sheet,tenantSheet,booking,'legacy123',()=>{}),true);
 before[12]='legacy123';assert.deepEqual(sheet.data[1],before);assert.deepEqual(sheet.writes,[[2,13,1,1]]);
 assert.equal(ctx.crmMigrationProjectCalendarId_(sheet,tenantSheet,booking,'legacy123',()=>{}),false);
 assert.equal(sheet.writes.length,1);
});
test('legacy ID projection rejects mismatched existing ID, changed booking and identity collision',()=>{
 const {booking,sheet,tenantSheet}=projectionFixture();
 assert.throws(()=>ctx.crmMigrationProjectCalendarId_(sheet,tenantSheet,booking,'wrong',()=>{}),/mismatch/);
 sheet.data[1][12]='other';assert.throws(()=>ctx.crmMigrationProjectCalendarId_(sheet,tenantSheet,booking,'legacy123',()=>{}),/differs/);
 sheet.data[1][12]='';sheet.data[1][4]='changed';assert.throws(()=>ctx.crmMigrationProjectCalendarId_(sheet,tenantSheet,booking,'legacy123',()=>{}),/changed/);
 sheet.data[1][4]=booking.direction;const other=copy(sheet.data[1]);other[11]='other';other[12]='legacy123';sheet.data.push(other);
 assert.throws(()=>ctx.crmMigrationProjectCalendarId_(sheet,tenantSheet,booking,'legacy123',()=>{}),/collision/);
 assert.equal(sheet.writes.length,0);
});
