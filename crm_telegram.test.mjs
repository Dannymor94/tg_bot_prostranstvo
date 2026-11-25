import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({});
for(const f of ['CrmCore.gs','CrmRegistry.gs','CrmSync.gs','CrmJournal.gs','CrmSheets.gs','CrmTelegramQuery.gs','CrmTelegram.gs','CrmTelegramPoll.gs'])vm.runInContext(readFileSync(new URL(f,import.meta.url),'utf8'),ctx);
const {crmTgParseQuery_:parse,crmTgQueryReply_:reply,crmTgDayBusy_:dayBusy,crmTgFreeFromBusy_:free,crmTgRole_:role,crmTgDispatch_:dispatch,crmTgStatusText_:status}=ctx;
const plain=x=>JSON.parse(JSON.stringify(x)),cfg=ctx.crmDefaultTariff_(),today='2026-11-25';
const query=(s,now=420)=>parse(s,today,now,cfg);
test('natural weekday, morning and duration without explicit time',()=>{
 assert.equal(query('ближайшее воскресенье').date,'2026-11-29');
 const q=query('завтра утром на 2 часа');assert.equal(q.date,'2026-11-26');assert.equal(q.part,'morning');assert.equal(q.duration,120);
 assert.equal(query('ближайший вторник вечером').date,'2026-12-01');
 assert.equal(query('следующая пятница').date,'2026-12-04');
 assert.equal(query('на следующей неделе понедельник').date,'2026-11-30');
 assert.equal(query('среда утром',600).date,'2026-12-02');
});
test('dates and fractional hours are distinct, exact minute range crosses tariff',()=>{
 assert.equal(query('27 ноября с 16 до 18').date,'2026-11-27');
 assert.equal(query('27.11 на 1,5 часа').duration,90);
 assert.equal(query('завтра на 1.5 часа').duration,90);
 assert.equal(query('завтра на час').duration,60);
 const q=query('сколько стоит суббота с 12 до 14');
 assert.equal(q.date,'2026-11-28');assert.equal(q.from,720);assert.equal(q.to,840);
 assert.equal(q.price,true);
});
test('ambiguous, invalid and unsupported text never yields an availability claim',()=>{
 for(const s of ['завтра послезавтра','вторник пятница','завтра утром вечером','завтра утром с 9 до 11','завтра с 19 до 18','завтра с 9:99 до 11','31.11','27.11.2025','завтра на 2 часа с 10 до 12','удали аренду завтра','завтра после 12']){
  assert.ok(query(s).error,s);
 }
});
test('free windows merge overlaps and clip full duration to period',()=>{
 assert.deepEqual(plain(free(cfg,today,[[360,420],[400,480],[600,660],[1320,1380]])),[[480,600],[660,1320]]);
 const r=reply(query('завтра утром на 2 часа'),today,420,cfg,()=>[[360,480]]);
 assert.match(r.text,/08:00–10:00/);assert.doesNotMatch(r.text,/10:00–/);
 const r2=reply(query('сегодня утром',540),today,540,cfg,()=>[]);
 assert.match(r2.text,/09:00–10:00/);
});
test('exact range returns both public rates without revealing identity or discount',()=>{
 const q=query('пятница с 16 до 18');
 const r=reply(q,today,420,cfg,()=>[]);
 assert.match(r.text,/Время свободно/);assert.match(r.text,/1500 ₽/);assert.match(r.text,/1700 ₽/);
 assert.match(reply(q,today,420,cfg,()=>[[1000,1010]]).text,/Время занято/);
 assert.throws(()=>reply(q,today,420,cfg,()=>{throw Error('unavailable');}));
});
const b=(o={})=>({id:'b1',date:today,from:600,to:660,tenantId:'t1',direction:'Private',format:'group',status:'confirmed',...o});
test('day occupancy combines freeBusy, accepted/CRM intervals, pending and unresolved rows',()=>{
 const request=(method,path,body)=>{assert.equal(method,'POST');assert.equal(path,'/freeBusy');assert.equal(body.timeMin,'2026-11-24T21:00:00.000Z');return {code:200,body:{calendars:{test:{busy:[{start:'2026-11-25T05:00:00Z',end:'2026-11-25T06:00:00Z'}]}}}};};
 const pending=b({id:'b2',from:720,to:780});
 const intent=ctx.crmSyncIntent_({id:'op',base:null,sheet:pending,calendar:null,calendarDeleted:false}).intent;
 const row={values:['date',1,2],display:['25.11.2026','15:00','16:00'],formulas:['','','']};
 const occupied=dayBusy(request,'test',today,[b()],[{intent,status:'pending'}],[row]);
 assert.deepEqual(plain(free(cfg,today,occupied)),[[360,480],[540,600],[660,720],[780,900],[960,1380]]);
 assert.throws(()=>dayBusy(()=>({code:200,body:{calendars:{test:{errors:[{}],busy:[]}}}}),'test',today,[],[],[]));
});
const msg=(id,text,type='private',chat=id)=>({message:{from:{id},chat:{id:chat,type},text}});
const cb=(id,data,type='private',chat=id)=>({callback_query:{from:{id},message:{chat:{id:chat,type}},data}});
const env={owner:'42',admins:['43'],cfg,today,nowMinute:420,nowMs:Date.parse('2026-11-25T07:00:00Z'),readBusy:()=>[],status:()=>null,adminRead:()=> 'PRIVATE'};
test('role checks actor identity, private chat and every admin callback',()=>{
 assert.equal(role(msg(42,'/menu'),'42',['43']),'owner');
 assert.equal(role(msg(43,'/menu'),'42',['43']),'admin');
 assert.equal(role(msg(42,'/menu','private',99),'42',['43']),'guest');
 assert.equal(role(cb(42,'v2|payments','group',42),'42',['43']),'guest');
 assert.equal(dispatch(cb(42,'v2|payments','group'),env),null);
 assert.match(dispatch(cb(99,'v2|payments'),env).text,/только администратору/);
 assert.equal(dispatch(cb(43,'v2|payments'),env).text,'PRIVATE');
 assert.match(dispatch(msg(43,'/status'),env).text,/только владельцу/);
 assert.match(dispatch(cb(42,'v2|add'),env).text,/пока не включено/);
 assert.ok(!JSON.stringify(dispatch(msg(99,'/menu'),env)).includes('v2|payments'));
 assert.ok(JSON.stringify(dispatch(msg(42,'/menu'),env)).includes('v2|payments'));
});
test('public dispatcher fails closed when availability unavailable',()=>{
 const r=dispatch(msg(99,'завтра'),{...env,readBusy:()=>{throw Error('private data');}});
 assert.match(r.text,/не удалось подтвердить/);assert.doesNotMatch(r.text,/private data/);
});
test('owner status distinguishes stale and degraded report',()=>{
 assert.match(status(null,env.nowMs),/не подтверждено/);
 assert.match(status(JSON.stringify({at:'2026-11-24T00:00:00Z',ok:true,pending:0,unmanaged:0,conflicts:0,errors:0}),env.nowMs),/не подтверждено/);
 assert.match(status(JSON.stringify({at:'2026-11-25T06:00:00Z',ok:false,pending:1,unmanaged:0,conflicts:0,errors:0}),env.nowMs),/Требуется внимание/);
});
