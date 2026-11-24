import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({});
for(const f of ['CrmCore.gs','CrmRegistry.gs','CrmSync.gs','CrmSheets.gs','CrmCalendar.gs'])vm.runInContext(readFileSync(new URL(f,import.meta.url),'utf8'),ctx);
const {crmSheetHeaders_:headers,crmSheetBookingPort_:sheetPort,crmAcceptedPort_:acceptedPort,crmCalendarPort_:calPort,crmCalendarEventId_:eventId,crmCalendarChanges_:changes,crmCalendarBody_:body}=ctx;
const plain=x=>JSON.parse(JSON.stringify(x));
const b=(overrides={})=>({id:'b1',date:'2026-11-27',from:960,to:1080,tenantId:'t1',direction:'Yoga',format:'group',status:'confirmed',...overrides});
function fakeSheet(name,rows=[]){
 const data=[plain(headers()[name]),...rows],width=data[0].length;
 const sheet={data,writes:0,formula:false,getName:()=>name,getLastColumn:()=>width,getLastRow:()=>data.length,getMaxRows:()=>1000,
 getRange(r,c,n,m){const values=()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>data[r-1+i]?.[c-1+j]??''));
 return {getValues:values,getFormulas:()=>Array.from({length:n},()=>Array(m).fill(sheet.formula?'=1':'')),
 getDisplayValues:()=>values().map((row,i)=>row.map((v,j)=>{
  if(name==='Аренды'&&r+i>1&&typeof v==='number'){
   const k=c+j;
   if(k===1)return new Date((v-25569)*86400000).toISOString().slice(0,10).split('-').reverse().join('.');
   if(k===2||k===3){const min=Math.round(v*1440);return String(Math.floor(min/60)).padStart(2,'0')+':'+String(min%60).padStart(2,'0');}
  }return String(v);
 })),
 setValues(rows){sheet.writes++;for(let i=0;i<n;i++){const target=data[r-1+i]??(data[r-1+i]=Array(width).fill(''));for(let j=0;j<m;j++)target[c-1+j]=rows[i][j];}}
 };}};return sheet;
}
const tenants=()=>fakeSheet('Арендаторы',[['Marina','Yoga','Групповое',true,'','','','t1']]);
test('managed Sheet create, row reorder and move preserve payment metadata',()=>{
 const s=fakeSheet('Аренды'),p=sheetPort(s,tenants(),()=>{});
 p.compareAndWrite('b1',null,b());p.compareAndWrite('b2',null,b({id:'b2',from:720,to:780}));
 s.data[1][6]=1700;s.data[1][7]=500;s.data[1][8]=1200;s.data[1][10]='Отметить оплату';
 [s.data[1],s.data[2]]=[s.data[2],s.data[1]];
 p.compareAndWrite('b1',b(),b({date:'2026-11-28'}));
 assert.equal(p.read('b1').date,'2026-11-28');assert.deepEqual(s.data[2].slice(6,9),[1700,500,1200]);assert.equal(s.data[2][10],'Отметить оплату');
 assert.equal(p.read('b2').from,720);
});
test('Sheet rejects stale snapshot, duplicate ID and formula injection',()=>{
 const s=fakeSheet('Аренды'),p=sheetPort(s,tenants(),()=>{});p.compareAndWrite('b1',null,b());
 assert.throws(()=>p.compareAndWrite('b1',null,b({direction:'new'})));
 assert.throws(()=>p.compareAndWrite('b1',b(),b({direction:'=IMPORTXML(1)'})));
 s.data.push([...s.data[1]]);assert.throws(()=>p.read('b1'));
});
test('unknown and ambiguous tenant fail closed; unassigned rows are not silently ignored',()=>{
 const s=fakeSheet('Аренды'),t=tenants(),p=sheetPort(s,t,()=>{});p.compareAndWrite('b1',null,b());
 s.data[1][3]='Unknown';assert.throws(()=>p.read('b1'));
 s.data[1][3]='Marina';s.data[1][16]='';t.data.push(['Marina','','',false,'','','','t2']);assert.throws(()=>p.read('b1'));
 s.data[1][11]='';assert.throws(()=>p.list());
});
test('accepted snapshot revision increments exactly once per change',()=>{
 const s=fakeSheet('_CRM_ACCEPTED'),p=acceptedPort(s,()=>{});
 p.compareAndWrite('b1',null,b());assert.equal(p.revision('b1'),1);
 p.compareAndWrite('b1',b(),b());assert.equal(p.revision('b1'),1);
 p.compareAndWrite('b1',b(),b({direction:'Qigong'}));assert.equal(p.revision('b1'),2);
 assert.throws(()=>p.compareAndWrite('b1',b(),b({direction:'other'})));
 assert.equal(p.read('b1').direction,'Qigong');
});
function fakeCal(){
 const calendarId='test@group.calendar.google.com',events=new Map(),calls=[];let rev=0;
 const state={events,calls,deny:false,failAfterInsert:false,precondition:false};
 state.request=(method,path,payload,headers)=>{
 calls.push({method,path,payload,headers});const suffix=path.split('/events')[1];
 if(suffix===undefined)return {code:state.deny?403:200,body:{id:calendarId,timeZone:'Europe/Moscow'}};
 const id=suffix?decodeURIComponent(suffix.slice(1)):payload?.id,e=events.get(id);
 if(method==='GET')return e?{code:200,body:plain(e)}:{code:404,body:null};
 if(method==='POST'){
  if(e)return {code:409,body:null};
  events.set(id,{...plain(payload),status:'confirmed',etag:'e'+(++rev)});
  if(state.failAfterInsert)throw Error('timeout after insert');
  return {code:200,body:plain(events.get(id))};
 }
 if(state.precondition||headers['If-Match']!==e?.etag)return {code:412,body:null};
 if(method==='PATCH'){events.set(id,{...e,...plain(payload),etag:'e'+(++rev)});return {code:200,body:plain(events.get(id))};}
 if(method==='DELETE'){events.delete(id);return {code:204,body:null};}
 throw Error('Unexpected method');
 };state.port=calPort(state.request,calendarId,()=> 'Marina');return state;
}
test('stable managed event ID, ambiguous insert recovery, move and delete',()=>{
 const f=fakeCal(),p=f.port;f.failAfterInsert=true;
 assert.throws(()=>p.compareAndWrite('b1',null,b()));f.failAfterInsert=false;
 assert.equal(p.read('b1').id,'b1');
 assert.match(eventId('b1'),/^[0-9a-v]{5,1024}$/);assert.equal(f.events.size,1);
 p.compareAndWrite('b1',b(),b({from:900}));assert.equal(p.read('b1').from,900);
 assert.equal(f.calls.find(x=>x.method==='PATCH').headers['If-Match'],'e1');
 p.compareAndWrite('b1',b({from:900}),null);assert.equal(p.read('b1'),null);
 assert.equal(f.calls.filter(x=>x.method==='POST').length,1);
});
test('Calendar rejects stale ETag and uncertain absence',()=>{
 const f=fakeCal(),p=f.port;p.compareAndWrite('b1',null,b());f.precondition=true;
 assert.throws(()=>p.compareAndWrite('b1',b(),b({from:900})),/412/);assert.equal(p.read('b1').from,960);
 f.deny=true;assert.throws(()=>p.read('missing'),/binding/);
});
test('Calendar unsupported events are not silently treated as absent',()=>{
 const f=fakeCal(),p=f.port;p.compareAndWrite('b1',null,b());
 const e=f.events.get(eventId('b1'));e.attendees=[{email:'demo@example.invalid'}];assert.throws(()=>p.read('b1'));
 e.attendees=[];e.description='manual';assert.throws(()=>p.read('b1'));
});
test('delta paging returns token only after final page, preserves cancellation',()=>{
 const calls=[],request=(_m,p)=>{calls.push(p);return p.includes('pageToken=')?{code:200,body:{items:[{id:'b',status:'cancelled'}],nextSyncToken:'new'}}:{code:200,body:{items:[{id:'a'}],nextPageToken:'p'}};};
 const r=changes(request,'test','old');assert.equal(r.full,false);assert.equal(r.nextSyncToken,'new');assert.equal(r.items[1].status,'cancelled');assert.ok(calls.every(x=>x.includes('syncToken=old')));
});
test('410 triggers full read; incomplete pagination throws without token',()=>{
 const calls=[],request=(_m,p)=>{calls.push(p);return p.includes('syncToken=')?{code:410,body:{}}:{code:200,body:{items:[{id:'a'}],nextSyncToken:'fresh'}};};
 assert.equal(changes(request,'test','old').full,true);assert.equal(calls.length,2);
 assert.throws(()=>changes(()=>({code:200,body:{items:[]}}),'test',null));
 assert.throws(()=>changes(()=>({code:200,body:{items:[{id:'a'},{id:'a'}],nextSyncToken:'x'}}),'test',null));
});

test('manual title edit is quarantined instead of silently overwritten',()=>{
 const f=fakeCal(),p=f.port;p.compareAndWrite('b1',null,b());
 f.events.get(eventId('b1')).summary='Manual rename';
 assert.throws(()=>p.read('b1'),/title changed/);
 assert.throws(()=>p.compareAndWrite('b1',b(),b({from:900})),/title changed/);
 assert.equal(f.events.get(eventId('b1')).summary,'Manual rename');
});
test('composed sheet, accepted, calendar and journal ports converge on create/move/cancel',()=>{
 vm.runInContext(readFileSync(new URL('CrmJournal.gs',import.meta.url),'utf8'),ctx);
 const s=fakeSheet('Аренды'),a=fakeSheet('_CRM_ACCEPTED'),t=tenants(),c=fakeCal();
 // Persistent journal test fixture shares the same sheet mock as the booking adapter.
 const j=fakeSheet('_CRM_ACCEPTED');
 j.data[0]=plain(ctx.crmJournalHeaders_());
 j.getName=()=> '_CRM_JOURNAL';j.getLastColumn=()=>5;
 const sp=sheetPort(s,t,()=>{}),ap=acceptedPort(a,()=>{}),cp=c.port,jp=ctx.crmJournalForSheet_(j,()=>{});
 const targets={sheet:sp,calendar:cp,accepted:ap};
 const port={...jp,read:(target,id)=>targets[target].read(id),compareAndWrite:(target,id,before,desired)=>targets[target].compareAndWrite(id,before,desired),isAvailable:()=>true};
 const initial=b(),moved=b({date:'2026-11-28',from:600,to:720}),cancelled={...moved,status:'cancelled'};
 sp.compareAndWrite('b1',null,initial);
 const plan=(id,base,sheet,calendar)=>ctx.crmSyncIntent_({id,base,sheet,calendar,calendarDeleted:!!base&&calendar===null&&base.status!=='cancelled'}).intent;
 const op=plan('create',null,initial,null);
 assert.equal(ctx.crmRunSync_(port,op).status,'done');
 assert.equal(ap.revision('b1'),1);
 c.port.compareAndWrite('b1',initial,moved);
 s.data[1][7]=500;
 assert.equal(ctx.crmRunSync_(port,plan('move',initial,initial,moved)).status,'done');
 assert.equal(sp.read('b1').date,'2026-11-28');
 assert.equal(s.data[1][7],500);
 assert.equal(ap.revision('b1'),2);
 sp.compareAndWrite('b1',moved,cancelled);
 assert.equal(ctx.crmRunSync_(port,plan('cancel',moved,cancelled,moved)).status,'done');
 assert.equal(cp.read('b1'),null);assert.equal(sp.read('b1').status,'cancelled');
 assert.equal(s.data[1][7],500);assert.equal(ap.revision('b1'),3);
});
