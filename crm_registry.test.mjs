import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const ctx=vm.createContext({});
for (const file of ['CrmCore.gs','CrmRegistry.gs']) vm.runInContext(readFileSync(new URL(file,import.meta.url),'utf8'),ctx);
const {crmMergeBooking_:merge,crmFindOverlap_:overlap,crmPlanPayment_:payment,crmPaymentSummary_:summary,crmValidateBooking_:validate}=ctx;
const plain=x=>JSON.parse(JSON.stringify(x));
const booking=(overrides={})=>({id:'b1',date:'2026-11-27',from:960,to:1080,tenantId:'t1',direction:'Yoga',format:'group',status:'confirmed',...overrides});
const receipt=(overrides={})=>({id:'p1',bookingId:'b1',date:'2026-11-24',kind:'receipt',amountKopecks:100000,actor:'admin1',...overrides});

test('unchanged snapshots do not require a write',()=>{
  const b=booking();assert.equal(merge(b,b,b).kind,'noop');
});
test('calendar move preserves identity and triggers price review',()=>{
  const b=booking(),c=booking({date:'2026-11-28',from:600,to:720});
  const r=merge(b,b,c);
  assert.equal(r.kind,'change');assert.deepEqual(plain(r.booking),c);assert.equal(r.priceReview,true);
});
test('sheet edit and calendar move merge without losing either',()=>{
  const r=merge(booking(),booking({direction:'Qigong'}),booking({date:'2026-11-28'}));
  assert.equal(r.kind,'change');assert.equal(r.booking.direction,'Qigong');assert.equal(r.booking.date,'2026-11-28');
});
test('same-field divergence cannot overwrite either edit',()=>{
  const r=merge(booking(),booking({from:900}),booking({from:1020}));
  assert.deepEqual(plain(r),{kind:'conflict',fields:['from']});
});
test('identical concurrent edit converges',()=>{
  const b=booking(),s=booking({direction:'Qigong'});
  assert.equal(merge(b,s,s).kind,'change');assert.equal(merge(b,s,s).priceReview,false);
});
test('cancel versus concurrent move is a conflict',()=>{
  assert.equal(merge(booking(),booking({status:'cancelled'}),booking({date:'2026-11-28'})).kind,'conflict');
});
test('cancelled records cannot be resurrected implicitly',()=>{
  const b=booking({status:'cancelled'});
  assert.equal(merge(b,b,booking()).kind,'conflict');
});
test('invalid merged interval does not become accepted',()=>{
  assert.equal(merge(booking(),booking({from:1050}),booking({to:1000})).kind,'conflict');
});
test('mismatched IDs, missing or invalid snapshot fail closed',()=>{
  assert.throws(()=>merge(booking(),booking(),booking({id:'b2'})));
  assert.throws(()=>merge(booking(),null,booking()));
  assert.throws(()=>validate(booking({tenantId:null})));
  assert.doesNotThrow(()=>validate(booking({status:'draft',tenantId:null,format:null,direction:''})));
});
test('adjacent slots allowed; active and draft overlaps detected; cancelled ignored',()=>{
  const b=booking();
  assert.deepEqual(plain(overlap(b,[b,booking({id:'b2',from:1080,to:1140}),booking({id:'b3',from:1020,to:1140,status:'draft'}),booking({id:'b4',status:'cancelled'}),booking({id:'b5',date:'2026-11-28'})])),['b3']);
  assert.throws(()=>overlap(b,[b,b]));
});
test('receipt is idempotent; same ID with changed amount rejected',()=>{
  const b=booking(),p=receipt(),r=payment(b,153000,[],p);
  assert.equal(r.kind,'append');assert.equal(r.summary.balanceKopecks,53000);
  assert.equal(payment(b,153000,[p],p).kind,'noop');
  assert.throws(()=>payment(b,153000,[p],receipt({amountKopecks:110000})));
});
test('moves and price review never mutate actual receipts',()=>{
  const p=receipt(),entries=[p],r=merge(booking(),booking(),booking({date:'2026-11-28'}));
  assert.equal(r.priceReview,true);
  assert.equal(summary(r.booking.id,180000,entries).paidKopecks,100000);
  assert.equal(summary(r.booking.id,80000,entries).creditKopecks,20000);
  assert.equal(entries.length,1);
});
test('cancellation retains payments and allows explicit refund',()=>{
  const b=booking({status:'cancelled'}),p=receipt();
  const r=payment(b,153000,[p],receipt({id:'refund1',kind:'refund',amountKopecks:40000}));
  assert.equal(r.summary.paidKopecks,60000);
  assert.throws(()=>payment(b,153000,[p],receipt({id:'p2'})));
  assert.throws(()=>payment(b,153000,[p],receipt({id:'refund2',kind:'refund',amountKopecks:100001})));
});
test('ledger rejects duplicate ID, negative amounts and wrong booking',()=>{
  assert.throws(()=>summary('b1',153000,[receipt(),receipt()]));
  assert.throws(()=>payment(booking(),153000,[],receipt({amountKopecks:-1})));
  assert.throws(()=>payment(booking(),153000,[],receipt({bookingId:'b2'})));
  assert.throws(()=>payment(booking(),153000,[receipt({bookingId:'b2'})],receipt()));
});
test('zero priced booking and full payment have no outstanding balance',()=>{
  assert.equal(summary('b1',0,[]).status,'paid');
  assert.equal(summary('b1',100000,[receipt()]).status,'paid');
  assert.equal(summary('b1',153000,[]).status,'unpaid');
});

test('different edits to date and endpoints never manufacture an interval',()=>{
 const b=booking();
 const r=merge(b,booking({date:'2026-11-28'}),booking({from:900}));
 assert.equal(r.kind,'conflict');assert.ok(r.fields.includes('interval'));
 assert.equal(merge(b,booking({from:900}),booking({to:1140})).kind,'conflict');
 assert.equal(merge(b,booking({from:900}),booking({from:900})).kind,'change');
 assert.equal(merge(b,booking({from:900}),booking({direction:'Pilates'})).kind,'change');
});
