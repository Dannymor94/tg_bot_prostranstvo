// Pure CRM booking and payment planning. No service calls, no mutation of inputs.
// Requires CrmCore.gs. Persistence adapters must enforce authorization, locks and revisions.
function crmId_(value) {
  if(typeof value!=="string"||!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw Error("Invalid record ID");
  return value;
}

function crmBookingFields_() {
  return ["date","from","to","tenantId","direction","format","status"];
}

function crmValidateBooking_(b) {
  if(!b||typeof b!=="object") throw Error("Missing booking");
  crmId_(b.id);
  crmCivilDate_(b.date);
  if(!Number.isInteger(b.from)||!Number.isInteger(b.to)||b.from<0||b.to>1440||b.to<=b.from) throw Error("Invalid booking interval");
  if(!["draft","confirmed","cancelled"].includes(b.status)) throw Error("Invalid booking status");
  if(b.tenantId!==null) crmId_(b.tenantId);
  if(typeof b.direction!=="string"||b.direction.length>200) throw Error("Invalid direction");
  if(b.format!==null&&!["individual","group"].includes(b.format)) throw Error("Invalid booking format");
  if(b.status==="confirmed"&&(!b.tenantId||!b.direction.trim()||!b.format)) throw Error("Incomplete confirmed booking");
  return b;
}

function crmBookingSnapshot_(b) {
  crmValidateBooking_(b);
  return Object.fromEntries(["id",...crmBookingFields_()].map(k=>[k,b[k]]));
}

function crmMergeBooking_(base, sheet, calendar) {
  // Inputs are complete normalized snapshots, not raw descriptions or partial reads.
  // A missing row/event is handled by the adapter; never infer deletion here.
  [base,sheet,calendar].forEach(crmValidateBooking_);
  if(base.id!==sheet.id||base.id!==calendar.id) throw Error("Booking identity mismatch");
  const keys=crmBookingFields_(), merged=crmBookingSnapshot_(base), conflicts=[];
  const sc=keys.filter(k=>sheet[k]!==base[k]), cc=keys.filter(k=>calendar[k]!==base[k]);
  for(const k of keys) {
    if(sc.includes(k)&&cc.includes(k)&&sheet[k]!==calendar[k]) conflicts.push(k);
    else if(sc.includes(k)) merged[k]=sheet[k];
    else if(cc.includes(k)) merged[k]=calendar[k];
  }
  // Cancellation must not silently swallow a concurrent reschedule or identity change.
  if((sheet.status==="cancelled"&&base.status!=="cancelled"&&cc.some(k=>k!=="status"))||
     (calendar.status==="cancelled"&&base.status!=="cancelled"&&sc.some(k=>k!=="status"))) conflicts.push("cancellation");
  if(base.status==="cancelled"&&keys.some(k=>merged[k]!==base[k])) conflicts.push("cancelled_record");
  if(conflicts.length) return {kind:"conflict",fields:[...new Set(conflicts)]};
  try {crmValidateBooking_(merged);} catch(e) {return {kind:"conflict",fields:["invalid_combination"]};}
  const changed=keys.filter(k=>merged[k]!==base[k]);
  return {kind:changed.length?"change":"noop",booking:merged,changed,
    priceReview:merged.status==="confirmed"&&(base.status!=="confirmed"||changed.some(k=>["date","from","to","tenantId","format"].includes(k)))};
}

function crmFindOverlap_(candidate,bookings) {
  crmValidateBooking_(candidate);
  if(!Array.isArray(bookings)) throw Error("Missing booking inventory");
  const ids=new Set();
  const found=[];
  for(const b of bookings) {
    crmValidateBooking_(b);
    if(ids.has(b.id)) throw Error("Duplicate booking ID");
    ids.add(b.id);
    if(candidate.status!=="cancelled"&&b.status!=="cancelled"&&b.id!==candidate.id&&b.date===candidate.date&&candidate.from<b.to&&candidate.to>b.from) found.push(b.id);
  }
  return found.sort();
}

function crmPaymentEntry_(p) {
  if(!p||typeof p!=="object") throw Error("Missing payment entry");
  crmId_(p.id);crmId_(p.bookingId);
  crmCivilDate_(p.date);
  if(!["receipt","refund"].includes(p.kind)||!Number.isSafeInteger(p.amountKopecks)||p.amountKopecks<=0) throw Error("Invalid payment amount or kind");
  if(typeof p.actor!=="string"||!p.actor.trim()||p.actor.length>128) throw Error("Missing payment actor");
  return {id:p.id,bookingId:p.bookingId,date:p.date,kind:p.kind,amountKopecks:p.amountKopecks,actor:p.actor};
}

function crmPaymentSummary_(bookingId,quotedKopecks,entries) {
  crmId_(bookingId);
  if(!Number.isSafeInteger(quotedKopecks)||quotedKopecks<0||!Array.isArray(entries)) throw Error("Invalid payment summary input");
  const ids=new Set();let paid=0;
  for(const raw of entries) {
    const p=crmPaymentEntry_(raw);
    if(ids.has(p.id)) throw Error("Duplicate payment ID");
    ids.add(p.id);
    if(p.bookingId!==bookingId) continue;
    paid+=p.kind==="receipt"?p.amountKopecks:-p.amountKopecks;
    if(!Number.isSafeInteger(paid)) throw Error("Payment total overflow");
  }
  if(paid<0) throw Error("Refund exceeds receipts");
  return {paidKopecks:paid,balanceKopecks:Math.max(0,quotedKopecks-paid),creditKopecks:Math.max(0,paid-quotedKopecks),
    status:paid>=quotedKopecks?"paid":paid===0?"unpaid":"partial"};
}

function crmPlanPayment_(booking,quotedKopecks,entries,intent) {
  crmValidateBooking_(booking);
  const p=crmPaymentEntry_(intent);
  if(p.bookingId!==booking.id) throw Error("Payment booking mismatch");
  const before=crmPaymentSummary_(booking.id,quotedKopecks,entries);
  const existing=entries.find(x=>x.id===p.id);
  if(existing) {
    if(JSON.stringify(crmPaymentEntry_(existing))!==JSON.stringify(p)) throw Error("Payment ID reused with different intent");
    return {kind:"noop",summary:before};
  }
  if(p.kind==="receipt"&&quotedKopecks===0) throw Error("Non-billable booking cannot receive payment");
  if(p.kind==="receipt"&&booking.status!=="confirmed") throw Error("Receipt requires confirmed booking");
  if(p.kind==="refund"&&p.amountKopecks>before.paidKopecks) throw Error("Refund exceeds receipts");
  return {kind:"append",entry:p,summary:crmPaymentSummary_(booking.id,quotedKopecks,[...entries,p])};
}
