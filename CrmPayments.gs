// Append-only payment persistence. Caller holds script lock, verifies binding and actor.
// Visible rubles are converted once to integer kopecks; no balance stored as payment.
function crmPaymentHeaders_(){return ["Дата платежа","ID аренды","Арендатор","Операция","Сумма, ₽","Источник","Ответственный","ID платежа"];}
function crmRublesToKopecks_(rubles){
  if(typeof rubles!=="number"||!Number.isFinite(rubles)||rubles<=0||rubles>100000000)throw Error("Invalid ruble amount");
  const k=Math.round(rubles*100);
  if(Math.abs(rubles*100-k)>0.00001||k<=0)throw Error("Invalid fractional kopeck");
  return k;
}
function crmPaymentPort_(sheet,flush){
  if(!sheet||sheet.getName()!=="Оплаты"||typeof flush!=="function")throw Error("Invalid payment sheet binding");
  function inventory(){
    const n=sheet.getLastRow();
    if(n<1||n>20001||sheet.getLastColumn()!==8)throw Error("Payment sheet dimensions");
    const range=sheet.getRange(1,1,n,8),raw=range.getValues(),display=range.getDisplayValues();
    if(range.getFormulas().some(r=>r.some(Boolean))||JSON.stringify(raw[0])!==JSON.stringify(crmPaymentHeaders_()))throw Error("Payment sheet schema or formula");
    const ids=new Set(),entries=[];
    for(let i=1;i<raw.length;i++){
      const v=raw[i];
      if(v.every(x=>x===""))throw Error("Blank payment ledger row");
      const kind=v[3]==="Поступление"?"receipt":v[3]==="Возврат"?"refund":null;
      const p=crmPaymentEntry_({id:v[7],bookingId:v[1],date:crmSheetDate_(display[i][0]),kind,amountKopecks:crmRublesToKopecks_(v[4]),actor:v[6]});
      if(ids.has(p.id))throw Error("Duplicate payment ID");
      ids.add(p.id);entries.push(p);
    }
    return entries;
  }
  function append(booking,quotedKopecks,intent,metadata){
    const before=inventory(),plan=crmPlanPayment_(booking,quotedKopecks,before,intent);
    if(plan.kind==="noop")return plan;
    if(!metadata||!["sheet","calendar","telegram"].includes(metadata.source))throw Error("Invalid payment source");
    const name=crmSheetSafeText_(metadata.tenantName).trim(),p=plan.entry;
    if(!name)throw Error("Missing tenant name");
    crmSheetSafeText_(p.actor);
    const row=sheet.getLastRow()+1;
    if(row>sheet.getMaxRows()||row>20001)throw Error("Payment capacity exhausted");
    const target=sheet.getRange(row,1,1,8);
    if(target.getFormulas()[0].some(Boolean)||target.getValues()[0].some(x=>x!==""))throw Error("Payment target not empty");
    if(JSON.stringify(inventory())!==JSON.stringify(before))throw Error("Payment ledger changed");
    target.setValues([[crmCivilDate_(p.date).getTime()/86400000+25569,p.bookingId,name,p.kind==="receipt"?"Поступление":"Возврат",p.amountKopecks/100,metadata.source,p.actor,p.id]]);
    flush();
    const after=inventory();
    if(JSON.stringify(after)!==JSON.stringify([...before,p]))throw Error("Payment append not verified");
    return plan;
  }
  return {list:inventory,append};
}
