import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({});
for(const f of ['CrmCore.gs','CrmRegistry.gs','CrmSync.gs','CrmSheets.gs','CrmIntake.gs','CrmPayments.gs','CrmTenants.gs','CrmTelegramQuery.gs','CrmTelegramAdmin.gs','CrmQuoteReview.gs','CrmTelegramNav.gs','CrmTelegram.gs','CrmCalendar.gs','CrmIntakeRuntime.gs','CrmPaymentIntents.gs'])vm.runInContext(readFileSync(new URL(f,import.meta.url),'utf8'),ctx);
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


test('button navigation chooses tenant and exact interval without typing IDs',()=>{
 const f=fixture(),step=ctx.crmTgUiStep_;
 const list=step('v2|add',true,f.env,null,'201',now);
 assert.match(list.reply.reply_markup.inline_keyboard[0][0].text,/Марина/);
 const select=step('v2|ui|201|0',true,f.env,list.state,'202',now);
 assert.equal(select.state.kind,'addTime');
 const result=step('пятница с 16 до 18',false,f.env,select.state,'203',now);
 assert.equal(result.command,'/add Марина | пятница с 16 до 18');
 assert.equal(f.plan(result.command,'203').quote,153000);
 assert.equal(f.states.sheet.size,0);
 assert.match(step('v2|ui|201|0',true,f.env,select.state,'204',now).reply.text,/устарела/);
});
test('schedule navigation binds booking revision and uses existing payment and cancel previews',()=>{
 const f=fixture(),id=f.seed(),step=ctx.crmTgUiStep_;
 f.env.accepted.list=()=>[...f.states.accepted.values()].map(clone);
 let list=step('v2|schedule',true,f.env,null,'301',now);
 let choose=list.state.choices.findIndex(x=>x.kind==='date');
 let select=step('v2|ui|301|'+choose,true,f.env,list.state,'302',now);
 list=step('пятница',false,f.env,select.state,'303',now);
 select=step('v2|ui|303|0',true,f.env,list.state,'304',now);
 assert.match(select.reply.text,/Остаток: 1530 ₽/);
 const pay=step('v2|ui|304|0',true,f.env,select.state,'305',now);
 assert.equal(f.plan(pay.command,'305').payment.amountKopecks,153000);
 f.rev.set(id,2);
 assert.throws(()=>step('v2|ui|304|0',true,f.env,select.state,'306',now));
 assert.equal(f.entries.length,0);
});
function tenantSheet(rows=[]){
 const data=[clone(ctx.crmSheetHeaders_()['Арендаторы']),...clone(rows)],s={data,writes:0,getName:()=> 'Арендаторы',getLastColumn:()=>8,getLastRow:()=>data.length,getMaxRows:()=>1000};
 s.getRange=(r,c,n,m)=>{
 const values=()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>data[r-1+i]?.[c-1+j]??''));
 return {getValues:values,getDisplayValues:()=>values().map(a=>a.map(String)),getFormulas:()=>Array.from({length:n},()=>Array(m).fill('')),
 setValues(v){s.writes++;for(let i=0;i<n;i++){const row=data[r-1+i]??(data[r-1+i]=Array(8).fill(''));for(let j=0;j<m;j++)row[c-1+j]=v[i][j];}}};};return s;
}
test('new tenant preview and idempotent append after lost response',()=>{
 const f=fixture(),sheet=tenantSheet();
 f.env.sheets['Арендаторы']=sheet;f.env.flush=()=>{throw Error('lost response');};
 const r=f.plan('/tenant Анна | Массаж | Индивидуальное | нет','401');
 assert.match(preview(r,f.env).text,/Анна/);assert.equal(sheet.writes,0);
 assert.throws(()=>f.run(r));assert.equal(f.record.status,'started');
 f.env.flush=()=>{};assert.equal(f.run(f.record).status,'done');
 assert.equal(sheet.writes,1);assert.equal(ctx.crmTenantProfiles_(sheet)[0].id,'tenant_401');
 assert.throws(()=>ctx.crmTenantAppend_(sheet,{...r.tenant,id:'other'},()=>{}));
});
test('tenant ID claim preserves manual details and rejects duplicate names',()=>{
 const s=tenantSheet([['Анна','Йога','Групповое','','contact','','note',''],['Борис','Массаж','Индивидуальное',true,'','','',''],[' Борис ','Йога','Групповое',false,'','','',''],['Черновик','','',false,'','','','']]);
 let n=0;const r=ctx.crmTenantClaimPass_(s,()=> 'id_'+(++n),()=>{},10);
 assert.equal(r.claimed,1);assert.equal(r.review,2);assert.equal(r.incomplete,1);
 assert.equal(s.data[1][4],'contact');assert.equal(s.data[1][6],'note');assert.equal(s.data[1][3],false);
 assert.equal(ctx.crmTenantClaimPass_(s,()=> 'id_'+(++n),()=>{},10).claimed,0);
});
test('guest cannot access navigation callback or tenant command',()=>{
 const env={owner:'42',admins:[],adminCommand:()=>{throw Error('must not call');},uiEnabled:true};
 for(const key of ['v2|ui|201|0','/tenant Анна | Йога | Групповое | нет']){
 const u=key.startsWith('/')?{message:{from:{id:99},chat:{id:99,type:'private'},text:key}}:{callback_query:{from:{id:99},message:{chat:{id:99,type:'private'}},data:key}};
 assert.match(ctx.crmTgDispatch_(u,env).text,/только администратору/);
 }
});

test('tenant creation cannot duplicate an unclaimed manual name',()=>{
 const sheet=tenantSheet([['Анна','Йога','Групповое',false,'','','','']]);
 assert.throws(()=>ctx.crmTenantAppend_(sheet,{id:'other',name:'анна',direction:'Йога',format:'group',regular:false},()=>{}));
 assert.equal(sheet.writes,0);
});
test('retry of free-text preview can route by durable update ID after navigation is cleared',()=>{
 let routed=null;
 const env={owner:'42',admins:[],uiEnabled:true,adminText:(id,updateId)=>id===42&&updateId===123,adminCommand:(_u,key)=>{routed=key;return {text:'preview'};}};
 const u={update_id:123,message:{from:{id:42},chat:{id:42,type:'private'},text:'пятница с 16 до 18'}};
 assert.equal(ctx.crmTgDispatch_(u,env).text,'preview');
 assert.equal(routed,u.message.text);
});

test('internal tenant creation, booking and receipt guard use explicit non-billable category',()=>{
 const f=fixture(),sheet=tenantSheet();f.env.sheets['Арендаторы']=sheet;f.env.flush=()=>{};
 const r=f.plan('/tenant Studio | Practice | Групповое | Внутренний','501');
 assert.equal(r.tenant.internal,true);assert.equal(r.tenant.regular,false);
 assert.match(preview(r,f.env).text,/Внутренний/);
 assert.equal(f.run(r).status,'done');
 const p=ctx.crmTenantProfiles_(sheet)[0];assert.equal(p.internal,true);
 f.env.profiles.push(p);
 const booking=f.plan('/add Studio | пятница с 16 до 18','502');
 assert.equal(booking.quote,0);assert.match(booking.tariffVersion,/^internal:/);
 assert.match(preview(booking,f.env).text,/без оплаты/);
 assert.equal(f.run(booking).status,'done');
 assert.equal(f.rows[booking.desired.id][6],0);
 assert.equal(f.states.calendar.size,1);
 assert.throws(()=>ctx.crmPlanPayment_(booking.desired,0,[],{id:'p',bookingId:booking.desired.id,date:today,kind:'receipt',amountKopecks:100,actor:'owner'}));
});
test('category dropdown schema accepts ordinary, regular and internal and writes category strings',()=>{
 const sheet=tenantSheet();sheet.data[0][3]='Категория';
 for(const [i,category] of ['Обычный','Постоянный','Внутренний'].entries()){
  const p=ctx.crmTenantDraft_('Tenant '+i,'Yoga','group',category,'t'+i);
  ctx.crmTenantAppend_(sheet,p,()=>{});
  assert.equal(sheet.data[i+1][3],category);
 }
 assert.equal(ctx.crmTenantProfiles_(sheet)[1].regular,true);
 assert.equal(ctx.crmTenantProfiles_(sheet)[2].internal,true);
});

function settlementFixture(line='Оплата: Отметить оплату',mark='Отметить оплату'){
 const f=fixture(),id=f.seed(),b=f.states.accepted.get(id),row=f.rows[id];
 row[10]=mark;f.env.calendarId='test';f.env.flush=()=>{};
 const orig=f.env.sheets['Аренды'].getRange;
 f.env.sheets['Аренды'].getRange=(r,c,n,m)=>c===11?{getValues:()=>[[row[10]]],getFormulas:()=>[['']],setValues(v){row[10]=v[0][0];}}:orig();
 let event={...ctx.crmCalendarBody_(b,'Марина'),id:ctx.crmRuntimeEventId_(id),etag:'e1',status:'confirmed'};
 if(line)event.description+='\n'+line;
 let writes=0,failPatch=false;
 const request=(method,path,body,headers)=>{
  if(method==='GET')return {code:200,body:clone(event)};
  assert.equal(method,'PATCH');assert.equal(headers['If-Match'],event.etag);
  assert.deepEqual(Object.keys(body),['description']);
  if(failPatch)return {code:412,body:{}};
  event={...event,...clone(body),etag:'e'+(++writes+1)};return {code:200,body:clone(event)};
 };
 const run=()=>ctx.crmPaymentIntentsPass_(f.env,request,today,(id,revision)=>'settle_'+id+'_'+revision,10);
 return {f,id,row,run,get event(){return event;},set failPatch(v){failPatch=v;}};
}
test('Sheet and Calendar full-payment instructions settle one outstanding amount',()=>{
 const t=settlementFixture(),p=t.f.plan('/pay '+t.id+' | 500','600');t.f.run(p);
 const r=t.run();assert.equal(r.receipts,1);assert.equal(r.cleared,1);
 assert.equal(t.f.entries.length,2);assert.equal(t.f.entries[1].amountKopecks,103000);
 assert.equal(t.row[10],'');assert.match(t.event.description,/Оплата: оплачено$/);
 assert.equal(t.run().receipts,0);assert.equal(t.f.entries.length,2);
});
test('Calendar-only payment and lost response recover without duplicates',()=>{
 const t=settlementFixture('Оплата: Отметить оплату','');t.f.env.fail='pay';
 assert.equal(t.run().errors.length,1);assert.equal(t.f.entries.length,1);
 t.f.env.fail=null;assert.equal(t.run().receipts,0);
 assert.match(t.event.description,/Оплата: оплачено$/);assert.equal(t.f.entries.length,1);
});
test('failed Calendar acknowledgement preserves marker and never creates second receipt',()=>{
 const t=settlementFixture();t.failPatch=true;
 assert.equal(t.run().errors.length,1);assert.equal(t.f.entries.length,1);
 t.failPatch=false;assert.equal(t.run().receipts,0);assert.equal(t.f.entries.length,1);
 assert.match(t.event.description,/Оплата: оплачено$/);
});
test('stale quote prevents settlement, read-only status never creates receipts',()=>{
 const t=settlementFixture();t.row[13]=2;
 assert.equal(t.run().review.length,1);assert.equal(t.f.entries.length,0);
 assert.equal(t.row[10],'Отметить оплату');
 const s=settlementFixture('Оплата: оплачено','');
 assert.equal(s.run().receipts,0);assert.match(s.event.description,/Оплата: не оплачено$/);
});
test('internal zero quote is not a fabricated payment',()=>{
 const t=settlementFixture();t.row[6]=0;t.row[14]='internal:2026-06-01';
 assert.equal(t.run().receipts,0);assert.equal(t.f.entries.length,0);
 assert.equal(t.row[10],'');assert.match(t.event.description,/Оплата: без оплаты$/);
});
test('settlement cannot be repeated automatically after refund on same revision',()=>{
 const t=settlementFixture();assert.equal(t.run().receipts,1);
 t.f.entries.push({id:'refund1',bookingId:t.id,date:today,kind:'refund',amountKopecks:10000,actor:'owner'});
 t.row[10]='Отметить оплату';assert.equal(t.run().errors.length,1);
 assert.equal(t.f.entries.length,2);assert.equal(t.row[10],'Отметить оплату');
});
