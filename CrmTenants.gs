// Tenant creation uses the same durable confirmed command lifecycle as rentals.
function crmTenantDraft_(name,direction,format,regular,id){
  crmId_(id);
  const safe=s=>{const v=crmSheetSafeText_(s).trim();if(!v||v.length>100||/[\r\n|]/.test(v))throw Error("Invalid tenant field");return v;};
  if(!["group","individual"].includes(format)||typeof regular!=="boolean")throw Error("Invalid tenant defaults");
  return {id,name:safe(name),direction:safe(direction),format,regular};
}
function crmTenantAppend_(sheet,p,flush){
  p=crmTenantDraft_(p.name,p.direction,p.format,p.regular,p.id);
  const inventory=crmTenantProfiles_(sheet),same=inventory.find(x=>x.id===p.id);
  if(same){
    if(JSON.stringify(same)!==JSON.stringify(p))throw Error("Tenant ID conflict");
    return {replayed:true};
  }
  if(inventory.some(x=>crmNameKey_(x.name)===crmNameKey_(p.name)))throw Error("Tenant name already exists");
  const row=sheet.getLastRow()+1;
  if(row>sheet.getMaxRows())throw Error("Tenant sheet capacity exhausted");
  const range=sheet.getRange(row,1,1,8);
  if(range.getValues()[0].some(x=>x!=="")||range.getFormulas()[0].some(Boolean))throw Error("Tenant target changed");
  range.setValues([[p.name,p.direction,p.format==="group"?"Групповое":"Индивидуальное",p.regular,"","","",p.id]]);
  flush();
  const actual=crmTenantProfiles_(sheet).find(x=>x.id===p.id);
  if(JSON.stringify(actual)!==JSON.stringify(p))throw Error("Tenant write not verified");
  return {replayed:false};
}
function crmTenantCommand_(text,env,today,now,actor,token){
  const m=/^\/tenant\s+(.+)$/i.exec(text);
  if(!m)return null;
  const parts=m[1].split("|").map(s=>s.trim());
  if(parts.length!==4||!["да","нет"].includes(parts[3]))throw Error("Invalid tenant fields");
  const p=crmTenantDraft_(parts[0],parts[1],crmSheetFormat_(parts[2]),parts[3]==="да","tenant_"+token);
  if(env.profiles.some(x=>crmNameKey_(x.name)===crmNameKey_(p.name)))throw Error("Tenant name exists");
  return {token,actor,action:"tenant",status:"preview",expires:now+15*60000,today,tenant:p};
}
function crmTenantExecute_(env,r,save,now,actor){
  if(r.actor!==actor)throw Error("Wrong actor");
  if(r.status==="done")return r;
  if(!["preview","started"].includes(r.status)||r.status==="preview"&&now>r.expires)throw Error("Expired command");
  if(r.status==="preview"){r={...r,status:"started"};save(r);}
  crmTenantAppend_(env.sheets["Арендаторы"],r.tenant,env.flush);
  r={...r,status:"done"};save(r);return r;
}
