// Financial projection over accepted bookings and append-only payments.
// Never silently reprice an agreed booking when its revision changes.
function crmFinancialRow_(row,booking,revision,profiles,cfg,entries){
  const v=row.values;
  if(row.formulas.some(Boolean)||!Number.isSafeInteger(revision)||revision<1||v[11]!==booking.id)throw Error("Invalid financial row");
  let quote=v[6],version=v[14],quotedRevision=v[13],state="Синхронизировано";
  if(quote===""&&version===""&&quotedRevision===""&&booking.status==="confirmed"&&revision===1){
    const p=profiles.find(x=>x.id===booking.tenantId);
    if(!p)throw Error("Missing quote tenant");
    const q=crmQuote_({...booking,regular:p.regular},cfg);
    quote=q.totalKopecks/100;version=q.tariffVersion;quotedRevision=revision;
  }else if(quote!==""&&version!==""&&quotedRevision===""&&revision===1){
    quotedRevision=1; // initial manual Sheet claim already persisted its quote
  }
  const missing=quote===""||version===""||quotedRevision==="";
  if(!missing){
    if(typeof version!=="string"||!version||!Number.isSafeInteger(quotedRevision)||quotedRevision<1||quotedRevision>revision||
       typeof quote!=="number"||!Number.isFinite(quote)||quote<0)throw Error("Invalid quote snapshot");
  }
  const k=quote===""?0:quote===0?0:crmRublesToKopecks_(quote);
  const payment=crmPaymentSummary_(booking.id,k,entries);
  const hasQuote=!missing;
  if(booking.status==="cancelled")state=payment.paidKopecks?"Отмена — проверить возврат":"Отменена";
  else if(booking.status==="draft")state="Черновик";
  else if(!hasQuote||quotedRevision!==revision)state="Проверить стоимость";
  // No receivable invented when quote missing; cancelled booking retains actual receipts.
  const balance=booking.status==="cancelled"?0:booking.status==="confirmed"&&hasQuote&&quotedRevision===revision?payment.balanceKopecks/100:"";
  const next=v.slice();
  next[6]=quote;next[7]=payment.paidKopecks/100;next[8]=balance;next[12]=crmRuntimeEventId_(booking.id);
  next[13]=quotedRevision;next[14]=version;next[15]=state;
  return next;
}
function crmFinancialPass_(sheet,tenantSheet,accepted,journal,profiles,cfg,entries,flush,limit){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("Invalid finance limit");
  const report={updated:0,review:0,errors:0,limited:false};
  const tenants=crmSheetTenants_(tenantSheet);
  for(const r of crmSheetRows_(sheet,"Аренды")){
    if(r.values[11]==="")continue;
    try{
      const b=crmSheetBookingRow_(r,tenants),base=accepted.read(b.id);
      if(!base||!crmSyncEqual_(base,b)||journal.hasPending(b.id)){report.review++;continue;}
      const next=crmFinancialRow_(r,b,accepted.revision(b.id),profiles,cfg,entries);
      if(next[15]!=="Синхронизировано"&&next[15]!=="Отменена"&&next[15]!=="Черновик")report.review++;
      if(JSON.stringify(next)===JSON.stringify(r.values))continue;
      if(report.updated>=limit){report.limited=true;break;}
      const target=sheet.getRange(r.row,1,1,17);
      if(target.getFormulas()[0].some(Boolean)||JSON.stringify(target.getValues()[0])!==JSON.stringify(r.values))throw Error("Financial row changed");
      target.setValues([next]);flush();
      if(JSON.stringify(target.getValues()[0])!==JSON.stringify(next))throw Error("Financial projection not verified");
      report.updated++;
    }catch(e){report.errors++;}
  }
  return report;
}
