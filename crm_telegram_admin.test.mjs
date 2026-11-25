import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({});
for(const f of ['CrmCore.gs','CrmRegistry.gs','CrmSync.gs','CrmSheets.gs','CrmIntake.gs','CrmPayments.gs','CrmTelegramQuery.gs','CrmTelegramAdmin.gs','CrmTelegram.gs'])vm.runInContext(readFileSync(new URL(f,import.meta.url),'utf8'),ctx);
const clone=x=>JSON.parse(JSON.stringify(x));
const {crmAdminCommand_:command,crmAdminExecute_:execute,crmAdminPreview_:preview}=ctx;
const today='2026-11-25',now=Date.parse('2026-11-25T07:00:00Z');
function fixture(){
 const states={sheet:new Map(),calendar:new Map(),accepted:new Map()},journal=new Map(),rev=new Map(),entries=[];
 const env={today,nowMinute:600,tariff:ctx.crmDefaultTariff_(),profiles:[{id:'t1',name:'Марина',direction:'Йога',format:'group',regular:true}],occupied:false,fail:null};
 const rows={};
 const headers=clone(ctx.crmSheetHeaders_()['Аренды']);
 const sheet={getName:()=> 'Аренды',getLastColumn:()=>17,getLastRow:()=>1+Object.keys(rows).length,
 getRange(){const data=[headers,...Object.values(rows)];return {getValues:()=>clone(data),getDisplayValues:()=>data.map(r=>r.map(String)),getFormulas:()=>data.map(r=>r.map(()=>''))};}};
 env.sheets={'Аренды':sheet};
 env.port={read:(t,id)=>clone(states[t].get(id)||null),isAvailable:()=>!env.occupied,
  load:id=>clone(journal.get(id)||null),list:()=>[...journal.values()].map(clone),
  hasPending:id=>[...journal.values()].some(r=>r.status!=='done'&&r.intent.desired.id===id),
  save:r=>journal.set(r.intent.id,clone(r)),
  compareAndWrite(t,id,before,desired,initialQuote=null){
   assert.equal(ctx.crmSyncEqual_(this.read(t,id),before),true);
   if(desired===null)states[t].delete(id);else states[t].set(id,clone(desired));
   if(t==='sheet'&&initialQuote){const v=Array(17).fill('');v[6]=initialQuote.totalKopecks/100;v[11]=id;v[14]=initialQuote.tariffVersion;rows[id]=v;}
   if(t==='accepted')rev.set(id,(rev.get(id)||0)+1);
   if(env.fail===t)throw Error('ambiguous write');
  }};
 env.journal=env.port;env.accepted={revision:id=>rev.get(id)||0};
 env.payments={list:()=>clone(entries),append(b,q,p){if(!entries.some(x=>x.id===p.id))entries.push(clone(p));if(env.fail==='pay')throw Error('ambiguous payment');}};
 let record=null;const save=r=>{record=clone(r);};
 const plan=(s,token='123')=>command(s,env,today,now,'42',token);
 const run=r=>execute(env,r,save,now,'42');
 function seed(){
  const r=plan('/add Марина | пятница с 16 до 18');run(r);
  const id=r.desired.id,v=Array(17).fill('');v[6]=1530;v[11]=id;v[13]=1;v[14]='2026-06-01';rows[id]=v;
  return id;
 }
 return {env,states,journal,rev,entries,rows,plan,run,save,seed,get record(){return record;}};
}
test('preview is read-only; confirm creates once and preserves stable ID',()=>{
 const f=fixture(),r=f.plan('/add Марина | пятница с 16 до 18');
 assert.equal(r.quote,153000);assert.equal(f.states.sheet.size,0);
 assert.match(preview(r,f.env).text,/1530 ₽/);
 assert.equal(f.run(r).status,'done');assert.equal(f.states.calendar.size,1);assert.equal(f.rows[r.desired.id][6],1530);
 assert.equal(f.run(f.record).status,'done');assert.equal(f.rev.get(r.desired.id),1);
});
test('expired and other actor confirmations cannot write',()=>{
 const f=fixture(),r=f.plan('/add Марина | пятница с 16 до 18');
 assert.throws(()=>execute(f.env,r,f.save,now+16*60000,'42'));
 assert.throws(()=>execute(f.env,r,f.save,now,'43'));assert.equal(f.states.sheet.size,0);
});
test('occupancy and changed quote rechecked at confirmation',()=>{
 const f=fixture(),r=f.plan('/add Марина | пятница с 16 до 18');f.env.occupied=true;
 assert.throws(()=>f.run(r));f.env.occupied=false;f.env.tariff.rates.weekday.group[1]=80000;
 assert.throws(()=>f.run(r));assert.equal(f.states.sheet.size,0);
});
test('booking write lost response resumes without duplicate',()=>{
 for(const phase of ['sheet','calendar','accepted']){
  const f=fixture(),r=f.plan('/add Марина | пятница с 16 до 18');f.env.fail=phase;
  assert.throws(()=>f.run(r));assert.equal(f.record.status,'started');f.env.fail=null;
  assert.equal(f.run(f.record).status,'done');assert.equal(f.states.calendar.size,1);assert.equal(f.rev.get(r.desired.id),1);
 }
});
test('move and cancel check revisions and retain booking identity',()=>{
 const f=fixture(),id=f.seed(),move=f.plan('/move '+id+' | суббота с 12 до 14','124');
 assert.equal(f.run(move).status,'done');assert.equal(f.states.calendar.get(id).date,'2026-11-28');
 assert.throws(()=>f.run(move)); // original preview revision is stale
 const cancel=f.plan('/cancel '+id,'125');assert.equal(f.run(cancel).status,'done');
 assert.equal(f.states.calendar.has(id),false);assert.equal(f.states.sheet.get(id).status,'cancelled');
});
test('partial payment, remaining payment and ambiguous response are idempotent',()=>{
 const f=fixture(),id=f.seed(),p=f.plan('/pay '+id+' | 500','124');f.env.fail='pay';
 assert.throws(()=>f.run(p));assert.equal(f.entries.length,1);f.env.fail=null;
 assert.equal(f.run(f.record).status,'done');assert.equal(f.entries.length,1);
 const rest=f.plan('/pay '+id+' | полностью','125');assert.equal(rest.payment.amountKopecks,103000);
 assert.equal(f.run(rest).status,'done');assert.equal(f.entries.length,2);
 assert.throws(()=>f.plan('/pay '+id+' | полностью','126'));
});
test('stale payment preview cannot charge again',()=>{
 const f=fixture(),id=f.seed(),a=f.plan('/pay '+id+' | 500','124'),b=f.plan('/pay '+id+' | 500','125');
 f.run(a);assert.throws(()=>f.run(b));assert.equal(f.entries.length,1);
});
test('guest cannot invoke command dispatcher',()=>{
 const env={owner:'42',admins:[],adminCommand:()=>{throw Error('must not call');}};
 const u={message:{from:{id:99},chat:{id:99,type:'private'},text:'/pay b1 | 500'}};
 assert.match(ctx.crmTgDispatch_(u,env).text,/только администратору/);
});
