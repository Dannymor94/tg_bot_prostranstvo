import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({});
for(const f of ['CrmCore.gs','CrmRegistry.gs','CrmSync.gs','CrmSheets.gs','CrmCalendar.gs','CrmIntake.gs','CrmPayments.gs'])vm.runInContext(readFileSync(new URL(f,import.meta.url),'utf8'),ctx);
const {crmManualBooking_:manual,crmManualSheetPlan_:sheetPlan,crmManualCalendarPlan_:calPlan,crmDefaultTariff_:cfg,crmPaymentPort_:payments,crmPaymentHeaders_:headers,crmRublesToKopecks_:kopecks}=ctx;
const plain=x=>JSON.parse(JSON.stringify(x));
const profiles=[{id:'t1',name:'Марина',direction:'Йога',format:'group',regular:true},{id:'t2',name:'Анна',direction:'Массаж',format:'individual',regular:false}];
const input={id:'b1',date:'2026-11-27',from:960,to:1080,name:'Марина'};
const event=(o={})=>({id:'google1',etag:'e1',summary:'Марина',status:'confirmed',start:{dateTime:'2026-11-27T13:00:00Z'},end:{dateTime:'2026-11-27T15:00:00Z'},...o});
test('name-only booking fills defaults and regular discount',()=>{
 const r=manual({...input,name:'  МАРИНА  '},profiles,cfg());
 assert.equal(r.kind,'ready');assert.equal(r.booking.tenantId,'t1');assert.equal(r.booking.direction,'Йога');assert.equal(r.booking.format,'group');assert.equal(r.quote.totalKopecks,153000);
});
test('unknown or duplicate name does not guess tariff or tenant',()=>{
 const r=manual({...input,name:'Новый'},profiles,cfg());
 assert.equal(r.reason,'unknown_tenant');assert.deepEqual(plain(r.occupied),{date:input.date,from:960,to:1080});assert.equal(r.quote,undefined);
 assert.equal(manual(input,[...profiles,{...profiles[0],id:'t3'}],cfg()).reason,'ambiguous_tenant');
});
test('explicit format and direction override profile, invalid interval rejected',()=>{
 const r=manual({...input,format:'individual',direction:'Психология'},profiles,cfg());
 assert.equal(r.quote.totalKopecks,135000);assert.equal(r.booking.direction,'Психология');
 assert.throws(()=>manual({...input,to:900},profiles,cfg()));
 assert.equal(manual({...input,from:300},profiles,cfg()).reason,'outside_tariff_or_invalid_quote');
});
function row(){
 const values=Array(17).fill('');values.splice(0,4,46353,960/1440,1080/1440,'Марина');
 const display=values.map(String);display.splice(0,3,'27.11.2026','16:00','18:00');
 return {values,display,formulas:Array(17).fill('')};
}
test('new sheet row without ID or format can be planned',()=>{
 const r=sheetPlan(row(),profiles,cfg(),'b1');
 assert.equal(r.kind,'ready');assert.equal(r.booking.id,'b1');assert.equal(r.quote.totalKopecks,153000);
});
test('partial sheet entry stays incomplete; injected financial cells rejected',()=>{
 const s=row();s.values[3]='';assert.equal(sheetPlan(s,profiles,cfg(),'b1').kind,'incomplete');
 const t=row();t.values[7]=100;assert.throws(()=>sheetPlan(t,profiles,cfg(),'b1'));
 const u=row();u.formulas[4]='=1';assert.throws(()=>sheetPlan(u,profiles,cfg(),'b1'));
});
test('calendar name or explicit direction, Moscow time, original identity retained',()=>{
 const r=calPlan(event(),profiles,cfg(),'b1');
 assert.equal(r.kind,'ready');assert.equal(r.booking.from,960);assert.equal(r.booking.to,1080);assert.equal(r.eventId,'google1');assert.equal(r.etag,'e1');
 assert.equal(calPlan(event({summary:'Марина — Цигун'}),profiles,cfg(),'b1').booking.direction,'Цигун');
});
test('unsupported recurring/all-day calendar events are flagged, not imported',()=>{
 assert.equal(calPlan(event({recurrence:['RRULE:FREQ=WEEKLY']}),profiles,cfg(),'b1').reason,'unsupported_calendar_event');
 assert.equal(calPlan(event({start:{date:'2026-11-27'}}),profiles,cfg(),'b1').kind,'review');
 assert.throws(()=>calPlan(event({extendedProperties:{private:{crmBookingId:'b1'}}}),profiles,cfg(),'b1'));
});
function fakeLedger(){
 const data=[plain(headers())],state={data,writes:0,formula:false,capacity:1000};
 state.getName=()=> 'Оплаты';state.getLastColumn=()=>8;state.getLastRow=()=>data.length;state.getMaxRows=()=>state.capacity;
 state.getRange=(r,c,n,m)=>{
  const values=()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>data[r-1+i]?.[c-1+j]??''));
  return {getValues:values,getFormulas:()=>Array.from({length:n},()=>Array(m).fill(state.formula?'=1':'')),
    getDisplayValues:()=>values().map((a,i)=>a.map((v,j)=>r+i>1&&c+j===1&&typeof v==='number'?new Date((v-25569)*86400000).toISOString().slice(0,10):String(v))),
    setValues(rows){state.writes++;for(let i=0;i<n;i++){const a=data[r-1+i]??(data[r-1+i]=Array(8).fill(''));for(let j=0;j<m;j++)a[c-1+j]=rows[i][j];}}
  };
 };return state;
}
const booking=manual(input,profiles,cfg()).booking;
const receipt=(o={})=>({id:'p1',bookingId:'b1',date:'2026-11-27',kind:'receipt',amountKopecks:50001,actor:'owner',...o});
const meta={source:'telegram',tenantName:'Марина'};
test('ledger append, reload and replay retain exact kopecks',()=>{
 const s=fakeLedger(),p=payments(s,()=>{});
 assert.equal(p.append(booking,153000,receipt(),meta).kind,'append');
 assert.equal(s.data[1][4],500.01);
 const restarted=payments(s,()=>{});
 assert.equal(restarted.list()[0].amountKopecks,50001);
 assert.equal(restarted.append(booking,153000,receipt(),meta).kind,'noop');
 assert.equal(s.writes,1);
 assert.throws(()=>restarted.append(booking,153000,receipt({amountKopecks:999}),meta));
});
test('ambiguous flush is recovered by payment ID, without double credit',()=>{
 const s=fakeLedger(),p=payments(s,()=>{throw Error('lost response');});
 assert.throws(()=>p.append(booking,153000,receipt(),meta));
 assert.equal(payments(s,()=>{}).append(booking,153000,receipt(),meta).kind,'noop');assert.equal(s.writes,1);
});
test('refund persists separately and excess refund fails',()=>{
 const s=fakeLedger(),p=payments(s,()=>{});
 p.append(booking,153000,receipt(),meta);
 const r=p.append(booking,153000,receipt({id:'p2',kind:'refund',amountKopecks:10001}),meta);
 assert.equal(r.summary.paidKopecks,40000);assert.equal(p.list().length,2);
 assert.throws(()=>p.append(booking,153000,receipt({id:'p3',kind:'refund',amountKopecks:40001}),meta));
});
test('ledger rejects corrupt data, formulas, fractional kopecks and unsafe text',()=>{
 const s=fakeLedger(),p=payments(s,()=>{});
 assert.throws(()=>p.append(booking,153000,receipt(),{...meta,tenantName:'=1'}));
 assert.throws(()=>kopecks(0.001));assert.throws(()=>kopecks('500'));
 s.formula=true;assert.throws(()=>p.list());s.formula=false;
 p.append(booking,153000,receipt(),meta);s.data.push([...s.data[1]]);assert.throws(()=>p.list());
});

function fakeBookingSheet(){
 const initial=row(),data=[plain(ctx.crmSheetHeaders_()['Аренды']),plain(initial.values)],s={data,writes:0};
 s.getName=()=> 'Аренды';s.getLastColumn=()=>17;s.getLastRow=()=>data.length;
 s.getRange=(r,c,n,m)=>{
  const values=()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>data[r-1+i]?.[c-1+j]??''));
  return {getValues:values,getFormulas:()=>Array.from({length:n},()=>Array(m).fill('')),
   getDisplayValues:()=>values().map((a,i)=>a.map((v,j)=>r+i===2&&c+j<=3?initial.display[c+j-1]:String(v))),
   setValues(rows){s.writes++;for(let i=0;i<n;i++)for(let j=0;j<m;j++)data[r-1+i][c-1+j]=rows[i][j];}
  };
 };return s;
}
test('claim assigns stable ID, fills defaults, and replays after lost flush',()=>{
 const s=fakeBookingSheet(),expected=ctx.crmSheetRows_(s,'Аренды')[0],claim=ctx.crmClaimManualRow_;
 assert.throws(()=>claim(s,expected,profiles,cfg(),'b1',()=>{throw Error('lost response');}));
 const r=claim(s,expected,profiles,cfg(),'b1',()=>{});
 assert.equal(r.replayed,true);assert.equal(s.data[1][11],'b1');assert.equal(s.data[1][16],'t1');
 assert.equal(s.data[1][5],'Групповое');assert.equal(s.writes,1);
});
test('claim never overwrites a changed or unresolved manual row',()=>{
 const s=fakeBookingSheet(),expected=ctx.crmSheetRows_(s,'Аренды')[0],claim=ctx.crmClaimManualRow_;
 s.data[1][4]='Изменено';assert.throws(()=>claim(s,expected,profiles,cfg(),'b1',()=>{}));
 assert.equal(s.writes,0);s.data[1][3]='Новый';
 const actual=ctx.crmSheetRows_(s,'Аренды')[0];
 assert.equal(claim(s,actual,profiles,cfg(),'b1',()=>{}).kind,'review');assert.equal(s.writes,0);
});

vm.runInContext(readFileSync(new URL('CrmSettings.gs',import.meta.url),'utf8'),ctx);
function settings(){
 const data=[['Параметр','Значение','Описание','','Тип дня','Формат','Утро, ₽/ч','День, ₽/ч','Вечер, ₽/ч']];
 const labels=['Версия тарифа','Действует с','Открытие','Конец утра','Конец дня','Закрытие','Скидка постоянным','Часовой пояс','Режим'];
 const values=['2026-06-01','2026-06-01',6/24,10/24,17/24,23/24,.1,'Europe/Moscow','TEST'];
 const table=[['Будни','Индивидуальное',500,500,1000],['Будни','Групповое',700,700,1000],['Выходные','Индивидуальное',500,700,1000],['Выходные','Групповое',900,900,1000]];
 for(let i=0;i<labels.length;i++)data.push([labels[i],values[i],'','',...(table[i]||Array(5).fill(''))]);
 return {data,formula:false,getName:()=> 'Настройки',getLastColumn:()=>9,getRange(){return {
  getValues:()=>data,getDisplayValues:()=>data.map((r,i)=>r.map((v,j)=>j===1&&i>=3&&i<=6?['06:00','10:00','17:00','23:00'][i-3]:String(v))),
  getFormulas:()=>data.map(r=>r.map(()=>this.formula?'=1':''))
 };}};
}
test('native settings price update needs no code edit',()=>{
 const s=settings(),read=ctx.crmReadSettings_;
 assert.deepEqual(plain(read(s)),plain(cfg()));
 s.data[2][8]=1200;
 assert.equal(manual(input,profiles,read(s)).quote.totalKopecks,171000);
});
test('settings reject malformed prices, environment, formulas and discount precision',()=>{
 const read=ctx.crmReadSettings_;
 for(const change of [s=>s.data[2][8]='1200',s=>s.data[9][1]='PROD',s=>s.formula=true,s=>s.data[7][1]=.12345,s=>s.data[3][4]='wrong']){
  const s=settings();change(s);assert.throws(()=>read(s));
 }
});

for(const f of ['CrmIntakeRuntime.gs','CrmFinanceProjection.gs'])vm.runInContext(readFileSync(new URL(f,import.meta.url),'utf8'),ctx);
test('intake automatically claims row and snapshots its initial quote',()=>{
 const s=fakeBookingSheet(),run=ctx.crmIntakeSheetPass_;
 const r=run(s,profiles,cfg(),()=> 'b1',()=>{},()=>true,5);
 assert.equal(r.claimed,1);assert.equal(s.data[1][6],1530);assert.equal(s.data[1][14],'2026-06-01');
 assert.equal(run(s,profiles,cfg(),()=> 'b2',()=>{},()=>true,5).claimed,0);
 assert.equal(s.writes,1);
});
test('unresolved complete sheet interval is occupied, unfinished row is not',()=>{
 const s=fakeBookingSheet(),r=ctx.crmUnclaimedRows_(s);
 assert.equal(ctx.crmUnclaimedOverlap_(booking,r),true);
 assert.equal(ctx.crmUnclaimedOverlap_(booking,r,2),false);
 s.data[1][2]='';assert.equal(ctx.crmUnclaimedOverlap_(booking,ctx.crmUnclaimedRows_(s)),false);
});
test('manual Calendar event adoption changes metadata only, preserves original ID and replays',()=>{
 let current=event(),patches=0;
 const request=(method,path,payload,headers)=>{
  if(method==='GET')return {code:200,body:plain(current)};
  assert.equal(method,'PATCH');assert.equal(headers['If-Match'],'e1');
  assert.equal(payload.start,undefined);assert.equal(payload.end,undefined);assert.equal(payload.id,undefined);
  current={...current,...plain(payload),etag:'e2'};patches++;return {code:200,body:plain(current)};
 };
 const r=ctx.crmAdoptCalendarEvent_(request,'test',event(),profiles,cfg());
 assert.equal(r.booking.id,'ext_google1');assert.equal(ctx.crmRuntimeEventId_(r.booking.id),'google1');
 assert.equal(current.start.dateTime,event().start.dateTime);assert.equal(current.id,'google1');
 assert.equal(ctx.crmAdoptCalendarEvent_(request,'test',event(),profiles,cfg()).replayed,true);
 assert.equal(patches,1);
});
test('adoption preserves notes and refuses changed etag',()=>{
 const never=()=>{throw Error('unexpected write');};
 assert.equal(ctx.crmAdoptCalendarEvent_(never,'test',event({description:'existing notes'}),profiles,cfg()).reason,'existing_description');
 assert.throws(()=>ctx.crmAdoptCalendarEvent_(()=>({code:200,body:event({etag:'new'})}),'test',event(),profiles,cfg()),/changed/);
});
test('finance projection snapshots quote, reflects actual receipts, does not reprice after move',()=>{
 const s=fakeBookingSheet();
 ctx.crmIntakeSheetPass_(s,profiles,cfg(),()=> 'b1',()=>{},()=>true,5);
 const r=ctx.crmSheetRows_(s,'Аренды')[0];
 const out=ctx.crmFinancialRow_(r,booking,1,profiles,cfg(),[receipt()]);
 assert.equal(out[6],1530);assert.equal(out[7],500.01);assert.equal(out[8],1029.99);assert.equal(out[13],1);
 const newer=cfg();newer.rates.weekday.group[2]=200000;
 const moved=ctx.crmFinancialRow_({values:out,formulas:r.formulas},{...booking,date:'2026-11-28'},2,profiles,newer,[receipt()]);
 assert.equal(moved[6],1530);assert.equal(moved[7],500.01);assert.equal(moved[8],'');assert.equal(moved[15],'Проверить стоимость');
 const cancelled=ctx.crmFinancialRow_({values:moved,formulas:r.formulas},{...booking,status:'cancelled'},3,profiles,newer,[receipt()]);
 assert.equal(cancelled[7],500.01);assert.equal(cancelled[8],0);assert.equal(cancelled[15],'Отмена — проверить возврат');
});
test('calendar-origin accepted booking receives first quote, subsequent tariff changes do not reprice',()=>{
 const r=row();r.values[11]='ext_google1';
 const b={...booking,id:'ext_google1'};
 const out=ctx.crmFinancialRow_(r,b,1,profiles,cfg(),[]);
 assert.equal(out[6],1530);assert.equal(out[12],'google1');assert.equal(out[8],1530);
 const changed=cfg();changed.rates.weekday.group[2]=200000;
 const same=ctx.crmFinancialRow_({values:out,formulas:r.formulas},b,1,profiles,changed,[]);
 assert.deepEqual(plain(same),plain(out));
});

test('internal financial projection retains zero snapshot and does not rewrite after profile changes',()=>{
 const internal=[{...profiles[0],regular:false,internal:true}];
 const b=manual(input,internal,cfg()).booking;
 const r=row();r.values[11]=b.id;
 const out=ctx.crmFinancialRow_(r,b,1,internal,cfg(),[]);
 assert.equal(out[6],0);assert.equal(out[7],0);assert.equal(out[8],0);
 assert.match(out[14],/^internal:/);assert.equal(out[15],'Без оплаты (внутренняя)');
 const same=ctx.crmFinancialRow_({values:out,formulas:r.formulas},b,1,profiles,cfg(),[]);
 assert.deepEqual(plain(same),plain(out));
});
test('internal quote does not bypass hours or masquerade as a promotional discount',()=>{
 const p=[{...profiles[0],regular:false,internal:true}];
 const r=manual(input,p,cfg());
 assert.equal(r.quote.totalKopecks,0);assert.equal(r.quote.discountBps,0);
 assert.equal(r.quote.baseKopecks,170000);assert.equal(r.quote.nonBillable,true);
 assert.equal(manual({...input,from:300},p,cfg()).kind,'review');
 assert.throws(()=>ctx.crmQuote_({...r.booking,regular:true,internal:true},cfg()));
 assert.throws(()=>ctx.crmValidateTariff_({...cfg(),version:'internal:forged'}));
});
