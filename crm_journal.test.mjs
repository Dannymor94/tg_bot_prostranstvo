import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({});
for(const file of ['CrmCore.gs','CrmRegistry.gs','CrmSync.gs','CrmJournal.gs']) vm.runInContext(readFileSync(new URL(file,import.meta.url),'utf8'),ctx);
const {crmJournalForSheet_:journal,crmJournalHeaders_:headers,crmSyncIntent_:plan}=ctx;
const plain=x=>JSON.parse(JSON.stringify(x));
const b={id:'b1',date:'2026-11-27',from:960,to:1080,tenantId:'t1',direction:'Yoga',format:'group',status:'confirmed'};
const intent=(id='op1',booking=b)=>plan({id,base:null,sheet:booking,calendar:null,calendarDeleted:false}).intent;
function fake(){
  const data=[plain(headers())],writes=[];
  const sheet={
    data,writes,name:'_CRM_JOURNAL',formulas:false,capacity:100,fail:false,
    getName(){return this.name;},getLastRow(){return data.length;},getLastColumn(){return 5;},getMaxRows(){return this.capacity;},
    getRange(r,c,n,m){return {
      getValues(){return Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>data[r-1+i]?.[c-1+j]??''));},
      getFormulas(){return Array.from({length:n},()=>Array(m).fill(sheet.formulas?'=1':''));},
      setValues(values){if(sheet.fail)throw Error('write failed');writes.push({r,c,n,m});
        for(let i=0;i<n;i++){const row=data[r-1+i]??(data[r-1+i]=Array(5).fill(''));for(let j=0;j<m;j++)row[c-1+j]=values[i][j];}}
    };}
  };
  return sheet;
}
test('journal persists intent, supports reread from new adapter, then commits once',()=>{
  const sheet=fake();let flushes=0;const j=journal(sheet,()=>flushes++),op=intent();
  j.save({intent:op,status:'pending'});
  const restarted=journal(sheet,()=>flushes++);
  assert.equal(restarted.hasPending('b1'),true);
  assert.equal(restarted.load('op1').status,'pending');
  restarted.save({intent:op,status:'done'});
  assert.equal(j.load('op1').status,'done');assert.equal(j.hasPending('b1'),false);
  restarted.save({intent:op,status:'done'});
  assert.equal(flushes,2);assert.equal(sheet.writes.length,2);assert.equal(sheet.data.length,2);
});
test('conflict persists in single range and freezes later operations',()=>{
  const sheet=fake(),j=journal(sheet,()=>{}),op=intent();
  j.save({intent:op,status:'pending'});
  j.save({intent:op,status:'conflict',reason:'changed_calendar'});
  assert.equal(j.load('op1').reason,'changed_calendar');
  assert.equal(j.hasPending('b1'),true);
  assert.throws(()=>j.save({intent:intent('op2'),status:'pending'}));
  assert.throws(()=>j.save({intent:op,status:'done'}));
  assert.deepEqual(sheet.writes[1],{r:2,c:3,n:1,m:3});
});
test('same ID cannot change intent',()=>{
  const j=journal(fake(),()=>{});j.save({intent:intent(),status:'pending'});
  assert.throws(()=>j.save({intent:intent('op1',{...b,direction:'Other'}),status:'pending'}));
});
test('schema corruption, formula, duplicate ID and forged payload fail closed',()=>{
  for(const damage of [
    s=>s.data[0][0]='Wrong',
    s=>s.formulas=true,
    s=>s.data.push([...s.data[1]]),
    s=>s.data[1][1]='booking:other',
    s=>s.data[1][3]='{}'
  ]){
    const s=fake(),j=journal(s,()=>{});j.save({intent:intent(),status:'pending'});damage(s);assert.throws(()=>j.load('op1'));
  }
});
test('no write on wrong target, exhausted sheet, or invalid status',()=>{
  const s=fake();s.name='Other';assert.throws(()=>journal(s,()=>{}));
  const t=fake(),j=journal(t,()=>{});t.capacity=1;
  assert.throws(()=>j.save({intent:intent(),status:'pending'}));
  assert.throws(()=>j.save({intent:intent(),status:'done'}));assert.equal(t.writes.length,0);
});
test('ambiguous flush can be safely reread and retried',()=>{
  const s=fake(),op=intent(),j=journal(s,()=>{throw Error('flush outcome unknown');});
  assert.throws(()=>j.save({intent:op,status:'pending'}));
  const retry=journal(s,()=>{});assert.equal(retry.load('op1').status,'pending');
  retry.save({intent:op,status:'pending'});assert.equal(s.writes.length,1);
});
