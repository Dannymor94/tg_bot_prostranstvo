import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const ctx=vm.createContext({});
vm.runInContext(readFileSync(new URL('./CrmCore.gs',import.meta.url),'utf8'),ctx);
const {crmDefaultTariff_:defaults,crmQuote_:quote,crmPeriod_:period,crmNearestWeekday_:nearest,crmClipFreeWindows_:clip,crmValidateTariff_:validate}=ctx;
const plain=x=>JSON.parse(JSON.stringify(x));
const request=(date,from,to,format='group',regular=false)=>({date,from,to,format,regular});
const fri='2026-11-27', sat='2026-11-28', sun='2026-11-29';
for(const [date,format,rates] of [
  [fri,'individual',[500,500,1000]], [fri,'group',[700,700,1000]],
  [sat,'individual',[500,700,1000]], [sat,'group',[900,900,1000]],
  [sun,'group',[900,900,1000]]
]){
  for(const [i,from] of [360,600,1020].entries()){
    test(date+' '+format+' tariff period '+i,()=>assert.equal(quote(request(date,from,from+60,format),defaults()).totalKopecks,rates[i]*100));
  }
}
test('weekday group crosses evening with 10% discount',()=>{
  const q=quote(request(fri,960,1080,'group',true),defaults());
  assert.equal(q.totalKopecks,153000);
  assert.equal(q.baseKopecks,170000);
  assert.deepEqual(plain(q.segments.map(s=>s.minutes)),[60,60]);
});
test('Saturday individual crosses morning/day',()=>assert.equal(quote(request(sat,570,630,'individual'),defaults()).totalKopecks,60000));
test('half hour evening and exact close',()=>assert.equal(quote(request(sun,1350,1380),defaults()).totalKopecks,50000));
test('round only final discounted total to kopecks',()=>assert.equal(quote(request(fri,360,361,'group',true),defaults()).totalKopecks,1050));
test('custom rate and discount loaded through configuration',()=>{
  const cfg=defaults(); cfg.rates.weekday.group[0]=12345;cfg.regularDiscountBps=250; cfg.version='new';
  const q=quote(request(fri,360,361,'group',true),cfg);
  assert.equal(q.totalKopecks,201);
  assert.equal(q.tariffVersion,'new');
});
test('invalid request fails closed',()=>{
  for(const r of [
    request('2026-02-30',360,420),
    request('2026-05-31',360,420),
    request(fri,359,420),request(fri,1320,1381),request(fri,420,420),
    request(fri,420.5,480),request(fri,360,420,'unknown'),
    request(fri,360,420,'group','false')
  ]) assert.throws(()=>quote(r,defaults()));
});
test('invalid configuration fails closed',()=>{
  const a=defaults();a.boundaries=[360,600,600,1380]; assert.throws(()=>validate(a));
  const b=defaults();b.rates.weekend.group[1]=-1;assert.throws(()=>validate(b));
  const c=defaults();c.regularDiscountBps=10001;assert.throws(()=>validate(c));
});
test('periods match tariff boundaries',()=>{
  assert.deepEqual(plain(period('morning',defaults())),[360,600]);
  assert.deepEqual(plain(period('day',defaults())),[600,1020]);
  assert.deepEqual(plain(period('evening',defaults())),[1020,1380]);
});
test('nearest weekday respects remaining period and exact end',()=>{
  const cfg=defaults();
  assert.equal(nearest('2026-11-24',599,2,'morning',cfg),'2026-11-24');
  assert.equal(nearest('2026-11-24',600,2,'morning',cfg),'2026-12-01');
  assert.equal(nearest('2026-11-24',1020,0,'all',cfg),sun);
  assert.equal(nearest('2026-12-31',1300,0,'all',cfg),'2027-01-03');
});
test('window must fit entirely within chosen period, exclude past time',()=>{
  const cfg=defaults();
  assert.deepEqual(plain(clip([[360,720],[960,1380]],'morning',480,60,cfg)),[[480,600]]);
  assert.deepEqual(plain(clip([[360,720],[960,1380]],'morning',550,60,cfg)),[]);
  assert.deepEqual(plain(clip([[960,1380]],'evening',0,120,cfg)),[[1020,1380]]);
  assert.deepEqual(plain(clip([[600,1020]],'day',0,0,cfg)),[[600,1020]]);
});
test('invalid availability input fails closed',()=>{
  assert.throws(()=>clip([[360,720],[700,800]],'all',0,0,defaults()));
  assert.throws(()=>clip([[360,350]],'all',0,0,defaults()));
});
