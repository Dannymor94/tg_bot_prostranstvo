import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({});
for(const file of ['CrmCore.gs','CrmRegistry.gs','CrmSync.gs'])vm.runInContext(readFileSync(new URL(file,import.meta.url),'utf8'),ctx);
const {crmSyncIntent_:plan,crmRunSync_:run,crmSyncEqual_:equal}=ctx;
const booking=(o={})=>({id:'b1',date:'2026-11-27',from:960,to:1080,tenantId:'t1',direction:'Yoga',format:'group',status:'confirmed',...o});
const clone=x=>JSON.parse(JSON.stringify(x));
const intent=(o={})=>plan({id:'op1',base:null,sheet:null,calendar:null,calendarDeleted:false,...o}).intent;
function port({sheet=null,calendar=null,accepted=null}={}){
  const state={sheet,calendar,accepted}; const journal=new Map(),writes=[];
  return {state,journal,writes,available:true,failBefore:null,failAfter:null,failSave:null,
    load:id=>journal.has(id)?clone(journal.get(id)):null,
    hasPending:id=>[...journal.values()].some(r=>r.intent.desired.id===id&&r.status!=='done'),
    save(r){if(this.failSave===r.status)throw Error('journal unavailable');journal.set(r.intent.id,clone(r));},
    read:(t,id)=>clone(state[t]),
    isAvailable(){return this.available;},
    compareAndWrite(t,id,before,after){
      assert.ok(journal.size>0,'journal must exist before writing');
      if(!equal(state[t],before))throw Error('CAS mismatch');
      if(this.failBefore===t)throw Error('transient before write');
      state[t]=clone(after);writes.push(t);
      if(this.failAfter===t)throw Error('ambiguous result after write');
    }
  };
}
test('creation from sheet, calendar and Telegram intent converges with same ID',()=>{
  // Telegram creates a draft in the sheet through its authorized adapter first.
  for(const origin of ['sheet','calendar']){
    const b=booking(),p=port({[origin]:b}),op=intent({[origin]:b});
    assert.equal(run(p,op).status,'done');
    for(const t of ['sheet','calendar','accepted'])assert.ok(equal(p.state[t],b));
    assert.equal(p.writes.filter(x=>x===origin).length,0);
    const count=p.writes.length;assert.equal(run(p,op).status,'done');assert.equal(p.writes.length,count);
  }
});
test('calendar move and distinct sheet edit converge',()=>{
  const b=booking(),s=booking({direction:'Qigong'}),c=booking({date:'2026-11-28'});
  const p=port({sheet:s,calendar:c,accepted:b}),op=intent({base:b,sheet:s,calendar:c});
  assert.equal(run(p,op).status,'done');assert.equal(p.state.accepted.date,'2026-11-28');assert.equal(p.state.accepted.direction,'Qigong');
});
test('calendar deletion requires verified absence and retains cancelled sheet row',()=>{
  const b=booking(),p=port({sheet:b,accepted:b});
  assert.throws(()=>intent({base:b,sheet:b}));
  const op=intent({base:b,sheet:b,calendarDeleted:true});
  assert.equal(run(p,op).status,'done');assert.equal(p.state.sheet.status,'cancelled');assert.equal(p.state.calendar,null);
});
test('sheet cancellation deletes managed calendar projection only',()=>{
  const b=booking(),s=booking({status:'cancelled'}),p=port({sheet:s,calendar:b,accepted:b});
  assert.equal(run(p,intent({base:b,sheet:s,calendar:b})).status,'done');
  assert.equal(p.state.calendar,null);assert.equal(p.state.accepted.status,'cancelled');
});
test('missing sheet row and conflicting new IDs never produce an intent',()=>{
  const b=booking();
  assert.equal(plan({id:'op',base:b,sheet:null,calendar:b,calendarDeleted:false}).kind,'conflict');
  assert.equal(plan({id:'op',base:null,sheet:b,calendar:booking({direction:'Other'}),calendarDeleted:false}).kind,'conflict');
});
test('journal failure blocks all target writes',()=>{
  const b=booking(),p=port({sheet:b});p.failSave='pending';
  assert.throws(()=>run(p,intent({sheet:b})));assert.deepEqual(p.writes,[]);
});
for(const target of ['sheet','calendar','accepted']){
  for(const phase of ['failBefore','failAfter']){
    test('recover '+phase+' '+target,()=>{
      const b=booking(),s=booking({direction:'Qigong'}),c=booking({date:'2026-11-28'});
      const p=port({sheet:s,calendar:c,accepted:b}),op=intent({base:b,sheet:s,calendar:c});
      p[phase]=target;
      assert.throws(()=>run(p,op));
      assert.equal(p.journal.get('op1').status,'pending');
      p[phase]=null;
      assert.equal(run(p,op).status,'done');
      for(const t of ['sheet','calendar','accepted'])assert.equal(p.writes.filter(x=>x===t).length,1);
    });
  }
}
test('failed final checkpoint is safely retried',()=>{
  const b=booking(),p=port({sheet:b}),op=intent({sheet:b});p.failSave='done';
  assert.throws(()=>run(p,op));p.failSave=null;
  assert.equal(run(p,op).status,'done');assert.equal(p.writes.length,2);
});
test('unexpected concurrent edit freezes without another write',()=>{
  const b=booking(),p=port({sheet:b}),op=intent({sheet:b});p.failAfter='calendar';
  assert.throws(()=>run(p,op));p.failAfter=null;p.state.calendar=booking({direction:'Manual'});
  assert.equal(run(p,op).status,'conflict');assert.equal(p.writes.length,1);
  assert.throws(()=>run(p,intent({id:'op2',sheet:b})));
});
test('availability collision does not write',()=>{
  const b=booking(),p=port({sheet:b});p.available=false;
  assert.equal(run(p,intent({sheet:b})).status,'conflict');assert.deepEqual(p.writes,[]);
});
test('operation ID cannot be reused with another payload',()=>{
  const b=booking(),p=port({sheet:b});run(p,intent({sheet:b}));
  assert.throws(()=>run(p,intent({sheet:booking({direction:'Other'})})));
});
test('forged desired state rejected before journaling',()=>{
  const b=booking(),p=port({sheet:b}),op=clone(intent({sheet:b}));op.desired.direction='Forged';
  assert.throws(()=>run(p,op));assert.equal(p.journal.size,0);
});
