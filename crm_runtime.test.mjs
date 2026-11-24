import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({});
for(const f of ['CrmCore.gs','CrmRegistry.gs','CrmSync.gs','CrmJournal.gs','CrmCalendar.gs','CrmRuntime.gs','CrmGasV2.gs'])vm.runInContext(readFileSync(new URL(f,import.meta.url),'utf8'),ctx);
const {crmRuntimePass_:pass,crmRuntimeAvailable_:available,crmCalendarBusy_:busy,crmSyncIntent_:plan}=ctx;
const copy=x=>JSON.parse(JSON.stringify(x));
const b=(o={})=>({id:'b1',date:'2026-11-27',from:960,to:1080,tenantId:'t1',direction:'Yoga',format:'group',status:'confirmed',...o});
function fake(seed={}){
 const states={sheet:new Map(),calendar:new Map(),accepted:new Map()},records=new Map(),writes=[];
 for(const [target,arr] of Object.entries(seed))for(const x of arr)states[target].set(x.id,copy(x));
 let serial=0;
 const p={states,records,writes,fail:null,occupied:false,
  inventory:()=>({ids:[...new Set(Object.values(states).flatMap(m=>[...m.keys()]))],unmanaged:[]}),
  list:()=>[...records.values()].map(copy),load:id=>records.has(id)?copy(records.get(id)):null,
  hasPending:id=>[...records.values()].some(r=>r.status!=='done'&&r.intent.desired.id===id),
  save:r=>records.set(r.intent.id,copy(r)),newId:()=> 'op'+(++serial),
  read:(t,id)=>states[t].has(id)?copy(states[t].get(id)):null,
  isAvailable:()=>!p.occupied,
  compareAndWrite(t,id,before,desired){
   assert.equal(ctx.crmSyncEqual_(p.read(t,id),before),true);
   if(desired===null)states[t].delete(id);else states[t].set(id,copy(desired));
   writes.push(t+':'+id);
   if(p.fail===t)throw Error('lost response');
  }
 };return p;
}
test('full pass converges managed create and move; unchanged rows generate no journal writes',()=>{
 const p=fake({sheet:[b()]});
 assert.equal(pass(p,10).completed,1);
 assert.equal(p.states.calendar.get('b1').date,b().date);
 assert.equal(p.records.size,1);
 assert.equal(pass(p,10).unchanged,1);assert.equal(p.records.size,1);
 p.states.calendar.set('b1',b({date:'2026-11-28'}));
 assert.equal(pass(p,10).completed,1);
 assert.equal(p.states.sheet.get('b1').date,'2026-11-28');
});
test('managed Calendar cancellation preserves Sheet row',()=>{
 const p=fake({sheet:[b()],accepted:[b()]});
 assert.equal(pass(p,10).ok,true);
 assert.equal(p.states.sheet.get('b1').status,'cancelled');
 assert.equal(p.states.accepted.get('b1').status,'cancelled');
});
test('pending operation resumed before creating new intent',()=>{
 const p=fake({sheet:[b()]});p.fail='calendar';
 const a=pass(p,10);assert.equal(a.ok,false);assert.equal(a.pending,1);
 p.fail=null;
 const r=pass(p,10);assert.equal(r.completed,1);assert.equal(r.pending,0);
 assert.equal(p.records.size,1);assert.equal(p.writes.filter(x=>x==='calendar:b1').length,1);
});
test('bounded scan rotates instead of starving later records',()=>{
 const a=b({id:'a'}),z=b({id:'z',from:600,to:660});
 const p=fake({sheet:[a,z],calendar:[a],accepted:[a]});
 const r=pass(p,1);assert.equal(r.limited,true);assert.equal(r.nextAfterId,'a');
 assert.equal(pass(p,1,r.nextAfterId).completed,1);
 assert.equal(p.states.calendar.has('z'),true);
});
test('conflicts freeze repeated work and missing Sheet is never silently cancelled',()=>{
 const p=fake({sheet:[b()],calendar:[b()],accepted:[b()]});
 p.states.sheet.delete('b1');const r=pass(p,10);
 assert.equal(r.ok,false);assert.equal(r.conflicts[0].reason,'missing_sheet_row');assert.equal(p.writes.length,0);
 const q=fake({sheet:[b()]});q.occupied=true;
 assert.equal(pass(q,10).conflicts[0].reason,'overlap');assert.equal(q.writes.length,0);
 q.occupied=false;assert.equal(pass(q,10).ok,false);assert.equal(q.records.size,1);
});
test('availability includes accepted old interval and unresolved operation ranges',()=>{
 const candidate=b({id:'b2'}),other=b();
 assert.equal(available(candidate,[other],[],()=>false),false);
 assert.equal(available(candidate,[{...other,status:'cancelled'}],[],()=>false),true);
 const intent=plan({id:'op1',base:null,sheet:other,calendar:null,calendarDeleted:false}).intent;
 assert.equal(available(candidate,[],[{intent,status:'pending'}],()=>false),false);
 assert.equal(available(candidate,[],[{intent,status:'done'}],()=>false),true);
 assert.throws(()=>available(candidate,[],[],()=>null));
});
test('live overlap excludes only verified own event and checks all pages',()=>{
 const own={id:'own',status:'confirmed',extendedProperties:{private:{crmBookingId:'b1'}}};
 const calls=[];
 const req=(_m,path)=>{calls.push(path);return path.includes('pageToken=')?{code:200,body:{items:[{id:'manual',status:'confirmed'}]}}:{code:200,body:{items:[own],nextPageToken:'p'}};};
 assert.equal(busy(req,'test',b(),'own'),true);assert.equal(calls.length,2);
 assert.match(calls[0],/singleEvents=true/);
 assert.equal(busy(()=>({code:200,body:{items:[own]}}),'test',b(),'own'),false);
 assert.equal(busy(()=>({code:200,body:{items:[{id:'own'}]}}),'test',b(),'own'),true);
 assert.throws(()=>busy(()=>({code:403,body:{}}),'test',b(),'own'));
});
test('unknown inventory prevents writes; unmanaged events degrade report',()=>{
 const p=fake({sheet:[b()]});
 p.inventory=()=>{throw Error('read failed');};
 assert.throws(()=>pass(p,10));assert.equal(p.writes.length,0);
 p.inventory=()=>({ids:[],unmanaged:['manual']});
 assert.equal(pass(p,10).ok,false);
});
