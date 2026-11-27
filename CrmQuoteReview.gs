// Explicit financial approval after an accepted revision. Uses the same actor-bound
// durable Telegram command as other writes. Price changes never touch ledger rows.
function crmQuoteReviewRow_(env,id){
  const rows=crmSheetRows_(env.sheets["Аренды"],"Аренды").filter(r=>r.values[11]===id);
  if(rows.length!==1||rows[0].formulas.some(Boolean))throw Error("Invalid quote row");
  const row=rows[0],v=row.values;
  const old={quote:v[6]===""?null:v[6]===0?0:crmRublesToKopecks_(v[6]),version:v[14],revision:v[13]};
  if(old.quote===null){
    if(old.version!==""||old.revision!=="")throw Error("Incomplete quote snapshot");
  }else if(typeof old.version!=="string"||!old.version||!(old.revision===""||Number.isSafeInteger(old.revision)&&old.revision>0))throw Error("Invalid quote snapshot");
  if(old.version.startsWith("internal:")&&old.quote!==0)throw Error("Invalid internal quote");
  return {row,old};
}
function crmQuoteReviewPlan_(env,b,revision,choice){
  const {row,old}=crmQuoteReviewRow_(env,b.id);
  if(row.values[10]!==""||env.hasCalendarPaymentIntent?.(b.id))throw Error("Clear pending payment instruction before reviewing price");
  if(b.status!=="confirmed"||!Number.isSafeInteger(revision)||revision<1||old.revision===revision||old.revision!==""&&old.revision>revision)throw Error("No quote review required");
  const p=env.profiles.find(x=>x.id===b.tenantId);
  if(!p)throw Error("Unknown tenant");
  const proposed=crmAdminQuote_(env,b);
  let quote,version;
  if(choice==="keep"){
    if(old.quote===null||old.version.startsWith("internal:")!==!!p.internal)throw Error("Existing quote cannot be kept for changed billing category");
    quote=old.quote;version=old.version;
  }else if(choice==="recalculate"){
    quote=proposed.totalKopecks;version=proposed.tariffVersion;
  }else throw Error("Invalid quote choice");
  const paid=crmPaymentSummary_(b.id,quote,env.payments.list()).paidKopecks;
  return {old,quote,version,paid,choice};
}
function crmQuoteReviewCommand_(text,env,today,now,actor,token){
  const m=/^\/quote(?:@\w+)?\s+([a-zA-Z0-9_-]{1,128})\s*\|\s*(keep|recalculate)$/.exec(text);
  if(!m)return null;
  const s=crmAdminReadStable_(env,m[1]),plan=crmQuoteReviewPlan_(env,s.booking,s.revision,m[2]);
  return {token,actor,action:"quote",status:"preview",expires:now+15*60000,today,before:s.booking,revision:s.revision,...plan};
}
function crmQuoteReviewExecute_(env,r,save,now,actor){
  if(r.actor!==actor)throw Error("Wrong actor");
  if(r.status==="done")return r;
  if(!["preview","started"].includes(r.status)||r.status==="preview"&&now>r.expires)throw Error("Expired review");
  const id=r.before.id,stable=crmAdminReadStable_(env,id);
  if(stable.revision!==r.revision||!crmSyncEqual_(stable.booking,r.before))throw Error("Booking changed");
  const expected={quote:r.quote,version:r.version,revision:r.revision};
  const current=crmQuoteReviewRow_(env,id);
  if(r.status==="started"&&JSON.stringify(current.old)===JSON.stringify(expected)){
    r={...r,status:"done"};save(r);return r;
  }
  const plan=crmQuoteReviewPlan_(env,stable.booking,stable.revision,r.choice);
  if(JSON.stringify(plan.old)!==JSON.stringify(r.old)||plan.quote!==r.quote||plan.version!==r.version||plan.paid!==r.paid)throw Error("Quote or receipts changed");
  if(r.status==="preview"){r={...r,status:"started"};save(r);}
  const sheet=env.sheets["Аренды"],row=current.row;
  // One contiguous write under shared lock; preserve all other cells as read.
  const target=sheet.getRange(row.row,1,1,17);
  if(target.getFormulas()[0].some(Boolean)||JSON.stringify(target.getValues()[0])!==JSON.stringify(row.values))throw Error("Quote row changed");
  const next=row.values.slice();
  next[6]=r.quote/100;next[13]=r.revision;next[14]=r.version;
  const projected=crmFinancialRow_({...row,values:next},stable.booking,r.revision,env.profiles,env.tariff,env.payments.list());
  target.setValues([projected]);env.flush();
  if(JSON.stringify(crmQuoteReviewRow_(env,id).old)!==JSON.stringify(expected))throw Error("Quote write not verified");
  r={...r,status:"done"};save(r);return r;
}
