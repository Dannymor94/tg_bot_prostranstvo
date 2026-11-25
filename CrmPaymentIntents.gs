// Full-settlement instruction from trusted private Calendar or CRM. A single
// stable receipt per booking revision is shared across both sources. Partial
// receipts/refunds remain explicit ledger operations (Telegram or admin).
const CRM_PAYMENT_MARKER_="Отметить оплату";
function crmPaymentLine_(money){
  if(money===null)return "Оплата: проверить стоимость";
  if(money.quote===0)return "Оплата: без оплаты";
  if(money.summary.balanceKopecks===0)return "Оплата: оплачено";
  return money.summary.paidKopecks>0?"Оплата: частично":"Оплата: не оплачено";
}
function crmSettleMarked_(env,booking,revision,today,idFor,source){
  const id=idFor(booking.id,revision);crmId_(id);crmCivilDate_(today);
  if(!["sheet","calendar"].includes(source))throw Error("Invalid settlement source");
  const stable=crmAdminReadStable_(env,booking.id);
  if(stable.revision!==revision||!crmSyncEqual_(stable.booking,booking)||booking.status!=="confirmed")throw Error("Booking changed");
  const m=crmAdminMoney_(env,booking.id,revision),prior=env.payments.list().find(p=>p.id===id);
  if(prior){
    if(prior.bookingId!==booking.id||prior.kind!=="receipt")throw Error("Settlement identity conflict");
    if(m.summary.balanceKopecks>0)throw Error("Prior settlement reversed; use explicit payment");
    return {kind:"replayed",money:m};
  }
  if(m.summary.balanceKopecks===0)return {kind:"already_settled",money:m};
  if(m.quote===0)throw Error("Non-billable booking");
  const p=crmPaymentEntry_({id,bookingId:booking.id,date:today,kind:"receipt",amountKopecks:m.summary.balanceKopecks,actor:"trusted:"+source});
  const name=env.profiles.find(x=>x.id===booking.tenantId)?.name;
  env.payments.append(booking,m.quote,p,{source,tenantName:name});
  return {kind:"recorded",money:crmAdminMoney_(env,booking.id,revision)};
}
function crmPaymentCalendarRead_(request,calendarId,id){
  const eventId=crmRuntimeEventId_(id),path="/calendars/"+encodeURIComponent(calendarId)+"/events/"+encodeURIComponent(eventId);
  const r=request("GET",path,null,{});
  if(r.code!==200)throw Error("Payment Calendar read unavailable");
  const b=crmCalendarSnapshot_(r.body,id,eventId),line=crmCalendarPaymentLine_(r.body.description);
  return {path,event:r.body,booking:b,...line};
}
function crmPaymentCalendarWrite_(request,calendarId,id,expected,line){
  if(expected.payment===line)return false;
  const fresh=crmPaymentCalendarRead_(request,calendarId,id);
  if(fresh.event.etag!==expected.event.etag||fresh.event.description!==expected.event.description)throw Error("Calendar payment edit changed");
  const result=request("PATCH",fresh.path,{description:fresh.base+"\n"+line},{"If-Match":fresh.event.etag});
  if(result.code!==200)throw Error("Calendar payment update failed");
  const after=crmPaymentCalendarRead_(request,calendarId,id);
  if(after.payment!==line||!crmSyncEqual_(after.booking,expected.booking))throw Error("Calendar payment update not verified");
  return true;
}
function crmPaymentSheetClear_(sheet,id,flush){
  const matches=crmSheetRows_(sheet,"Аренды").filter(r=>r.values[11]===id);
  if(matches.length!==1||matches[0].formulas.some(Boolean))throw Error("Payment row changed");
  const row=matches[0];
  if(row.values[10]==="")return false;
  if(row.values[10]!==CRM_PAYMENT_MARKER_)throw Error("Unknown payment instruction");
  // Only clear the action cell, never rewrite booking or financial values.
  const cell=sheet.getRange(row.row,11,1,1);
  if(cell.getFormulas()[0][0]||cell.getValues()[0][0]!==CRM_PAYMENT_MARKER_)throw Error("Payment action changed");
  cell.setValues([[""]]);flush();
  if(cell.getValues()[0][0]!=="")throw Error("Payment action not cleared");
  return true;
}
function crmPaymentIntentsPass_(env,request,today,idFor,limit){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("Invalid payment pass limit");
  const sheet=env.sheets["Аренды"],rows=crmSheetRows_(sheet,"Аренды"),report={receipts:0,cleared:0,projected:0,review:[],errors:[],limited:false};
  let budget=limit;
  for(const r of rows){
    const id=r.values[11],mark=r.values[10];
    if(!id)continue;
    try{
      if(mark!==""&&mark!==CRM_PAYMENT_MARKER_){report.review.push({id,reason:"unknown_sheet_payment_action"});continue;}
      const b=env.port.read("accepted",id);
      if(!b||b.status!=="confirmed"){
        if(mark)report.review.push({id,reason:"unconfirmed_payment_action"});
        continue;
      }
      const cal=crmPaymentCalendarRead_(request,env.calendarId,id);
      const calendarMark=cal.payment==="Оплата: "+CRM_PAYMENT_MARKER_;
      let stable,money=null;
      try{stable=crmAdminReadStable_(env,id);money=crmAdminMoney_(env,id,stable.revision);}catch(e){
        if(mark||calendarMark)report.review.push({id,reason:"payment_requires_stable_quote"});
        continue;
      }
      if(!crmSyncEqual_(cal.booking,stable.booking))throw Error("Calendar payment snapshot changed");
      if(mark||calendarMark){
        if(!budget){report.limited=true;continue;}
        budget--;
        const settled=crmSettleMarked_(env,stable.booking,stable.revision,today,idFor,mark?"sheet":"calendar");
        money=settled.money;
        if(settled.kind==="recorded")report.receipts++;
        if(mark&&crmPaymentSheetClear_(sheet,id,env.flush))report.cleared++;
        if(crmPaymentCalendarWrite_(request,env.calendarId,id,cal,crmPaymentLine_(money)))report.projected++;
      }else{
        const line=crmPaymentLine_(money);
        if(cal.payment!==line){
          if(!budget){report.limited=true;continue;}
          budget--;
          if(crmPaymentCalendarWrite_(request,env.calendarId,id,cal,line))report.projected++;
        }
      }
    }catch(e){report.errors.push({id,reason:"payment_intent_or_projection_failed"});}
  }
  return report;
}
function crmPaymentStableId_(id,revision){
  crmId_(id);
  if(!Number.isSafeInteger(revision)||revision<1)throw Error("Invalid payment revision");
  const digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,id+":"+revision,Utilities.Charset.UTF_8);
  return "settle_"+digest.map(x=>((x+256)%256).toString(16).padStart(2,"0")).join("");
}
