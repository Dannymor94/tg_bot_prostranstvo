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
  if(inventory.some(x=>crmNameKey_(x.name)===crmNameKey_(p.name))||crmSheetRows_(sheet,"Арендаторы").some(r=>r.values[7]===""&&typeof r.values[0]==="string"&&crmNameKey_(r.values[0])===crmNameKey_(p.name)))throw Error("Tenant name already exists");
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

function crmTenantClaimPass_(sheet,newId,flush,limit){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("Invalid tenant claim limit");
  const report={claimed:0,review:0,incomplete:0,errors:0,limited:false};
  const rows=crmSheetRows_(sheet,"Арендаторы"),profiles=crmTenantProfiles_(sheet);
  const names=new Set(profiles.map(p=>crmNameKey_(p.name))),counts=new Map();
  for(const r of rows)if(r.values[7]===""&&typeof r.values[0]==="string"&&r.values[0].trim()){
    const key=crmNameKey_(r.values[0]);counts.set(key,(counts.get(key)||0)+1);
  }
  for(const r of rows){
    if(r.values[7]!=="")continue;
    try{
      if(r.formulas.some(Boolean))throw Error("Formula in tenant row");
      const v=r.values;
      if([0,1,2].some(i=>v[i]==="")){report.incomplete++;continue;}
      const key=crmNameKey_(v[0]);
      if(names.has(key)||counts.get(key)!==1){report.review++;continue;}
      if(report.claimed>=limit){report.limited=true;break;}
      const p=crmTenantDraft_(v[0],v[1],crmSheetFormat_(v[2]),v[3]===""?false:v[3],newId());
      if(crmTenantProfiles_(sheet).some(x=>x.id===p.id||crmNameKey_(x.name)===key))throw Error("Tenant identity changed");
      const target=sheet.getRange(r.row,1,1,8);
      if(target.getFormulas()[0].some(Boolean)||JSON.stringify(target.getValues()[0])!==JSON.stringify(v))throw Error("Tenant row changed");
      const next=v.slice();next[0]=p.name;next[1]=p.direction;next[3]=p.regular;next[7]=p.id;
      for(const x of next)if(typeof x==="string")crmSheetSafeText_(x);
      target.setValues([next]);flush();
      if(JSON.stringify(crmTenantProfiles_(sheet).find(x=>x.id===p.id))!==JSON.stringify(p))throw Error("Tenant claim not verified");
      names.add(key);report.claimed++;
    }catch(e){report.errors++;}
  }
  return report;
}
