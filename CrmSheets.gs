// CRM v2 Sheets adapter. Internal: caller validates TEST binding and holds script lock.
// Sheet UI edits bypass locks. Re-read around writes; not a cross-service transaction.
// Existing managed rows only; ID assignment and financial projection are separate gates.
function crmSheetHeaders_(){
  return {
    "Аренды":["Дата","Начало","Конец","Арендатор","Направление","Формат","Стоимость, ₽","Получено, ₽","Остаток, ₽","Статус","Действие с оплатой","ID аренды","ID Calendar","Ревизия","Версия тарифа","Синхронизация","ID арендатора"],
    "Арендаторы":["Имя","Направление","Формат","Постоянный","Контакт","Регулярное расписание","Примечание","ID арендатора"],
    "_CRM_ACCEPTED":["Booking ID","Revision","Accepted JSON"]
  };
}
function crmSheetRows_(sheet,title){
  const h=crmSheetHeaders_()[title];
  if(!h||!sheet||sheet.getName()!==title||sheet.getLastColumn()!==h.length)throw Error("Sheet schema mismatch: "+title);
  const n=sheet.getLastRow();
  if(n<1||n>20001)throw Error("Sheet capacity invalid");
  const range=sheet.getRange(1,1,n,h.length),raw=range.getValues(),display=range.getDisplayValues(),formulas=range.getFormulas();
  if(JSON.stringify(raw[0])!==JSON.stringify(h)||formulas[0].some(Boolean))throw Error("Sheet header mismatch: "+title);
  return raw.slice(1).map((values,i)=>({row:i+2,values,display:display[i+1],formulas:formulas[i+1]})).filter(r=>r.values.some(x=>x!==""&&x!==null));
}
function crmSheetDate_(display){
  if(typeof display!=="string")throw Error("Invalid displayed date");
  const m=/^(\d{2})\.(\d{2})\.(\d{4})$/.exec(display);
  const key=m?m[3]+"-"+m[2]+"-"+m[1]:display;
  crmCivilDate_(key);return key;
}
function crmSheetMinute_(display){
  const m=/^(\d{2}):(\d{2})$/.exec(display);
  if(!m||Number(m[1])>23||Number(m[2])>59)throw Error("Invalid displayed time");
  return Number(m[1])*60+Number(m[2]);
}
function crmSheetSafeText_(value){
  if(typeof value!=="string"||/^[\s\uFEFF]*=/.test(value))throw Error("Unsafe or invalid sheet text");
  return value;
}
function crmSheetFormat_(value){
  if(value==="Индивидуальное")return "individual";
  if(value==="Групповое")return "group";
  if(value==="")return null;
  throw Error("Unknown booking format");
}
function crmSheetStatus_(value){
  if(value==="Черновик")return "draft";
  if(value==="Подтверждена")return "confirmed";
  if(value==="Отменена")return "cancelled";
  throw Error("Unknown booking status");
}
function crmSheetTenants_(sheet){
  const byId=new Map(),byName=new Map();
  for(const r of crmSheetRows_(sheet,"Арендаторы")){
    if(r.formulas.some(Boolean))throw Error("Formula in tenant row");
    const id=crmId_(r.values[7]),name=crmSheetSafeText_(r.values[0]).trim();
    if(!name||byId.has(id))throw Error("Duplicate or invalid tenant");
    byId.set(id,name);
    const key=name.toLowerCase();
    byName.set(key,[...(byName.get(key)||[]),id]);
  }
  return {byId,byName};
}
function crmSheetBookingRow_(r,tenants){
  const v=r.values;
  if(r.formulas.some(Boolean))throw Error("Formula in managed booking row");
  const id=crmId_(v[11]);
  const name=crmSheetSafeText_(v[3]).trim(),hidden=v[16];
  let tenantId=null;
  if(hidden!=="")crmId_(hidden);
  if(name){
    const ids=tenants.byName.get(name.toLowerCase())||[];
    if(hidden&&tenants.byId.get(hidden)===name)tenantId=hidden;
    else if(ids.length===1)tenantId=ids[0];
    else throw Error("Unknown or ambiguous tenant");
  }
  const booking={id,date:crmSheetDate_(r.display[0]),from:crmSheetMinute_(r.display[1]),to:crmSheetMinute_(r.display[2]),tenantId,direction:crmSheetSafeText_(v[4]),format:crmSheetFormat_(v[5]),status:crmSheetStatus_(v[9])};
  return crmBookingSnapshot_(booking);
}
function crmSheetBookingPort_(sheet,tenantSheet,flush){
  if(typeof flush!=="function")throw Error("Missing flush");
  function inventory(){
    const tenants=crmSheetTenants_(tenantSheet),map=new Map();
    for(const r of crmSheetRows_(sheet,"Аренды")){
      const booking=crmSheetBookingRow_(r,tenants);
      if(map.has(booking.id))throw Error("Duplicate booking ID");
      map.set(booking.id,{r,booking});
    }
    return {map,tenants};
  }
  function read(id){crmId_(id);return inventory().map.get(id)?.booking||null;}
  function list(){return [...inventory().map.values()].map(x=>x.booking);}
  function compareAndWrite(id,before,desired){
    crmId_(id);crmValidateBooking_(desired);
    if(id!==desired.id)throw Error("Booking ID mismatch");
    const {map,tenants}=inventory(),old=map.get(id);
    if(!crmSyncEqual_(old?.booking||null,before))throw Error("Sheet compare mismatch");
    if(desired.to===1440)throw Error("Midnight not supported in sheet adapter");
    const name=desired.tenantId===null?"":tenants.byId.get(desired.tenantId);
    if(name===undefined)throw Error("Unknown tenant ID");
    const row=old?.r.row||sheet.getLastRow()+1;
    if(row>sheet.getMaxRows())throw Error("Booking capacity exhausted");
    const v=old?old.r.values.slice():Array(17).fill("");
    const status={draft:"Черновик",confirmed:"Подтверждена",cancelled:"Отменена"}[desired.status];
    const format=desired.format===null?"":{individual:"Индивидуальное",group:"Групповое"}[desired.format];
    const dateSerial=crmCivilDate_(desired.date).getTime()/86400000+25569;
    v[0]=dateSerial;v[1]=desired.from/1440;v[2]=desired.to/1440;v[3]=name;v[4]=crmSheetSafeText_(desired.direction);v[5]=format;
    v[9]=status;v[11]=id;v[16]=desired.tenantId||"";
    // Preserve all nonbooking values, including payment intent, amounts and metadata.
    // Reject formulas rather than copying evaluated values over them.
    for(const x of v)if(typeof x==="string")crmSheetSafeText_(x);
    const target=sheet.getRange(row,1,1,17);
    if(target.getFormulas()[0].some(Boolean))throw Error("Formula in target row");
    const expected=old?old.r.values:Array(17).fill("");
    if(JSON.stringify(target.getValues()[0])!==JSON.stringify(expected))throw Error("Sheet row changed before write");
    target.setValues([v]);flush();
    if(!crmSyncEqual_(read(id),desired))throw Error("Sheet write not verified");
  }
  return {read,list,compareAndWrite};
}
function crmAcceptedPort_(sheet,flush){
  if(typeof flush!=="function")throw Error("Missing flush");
  function inventory(){
    const map=new Map();
    for(const r of crmSheetRows_(sheet,"_CRM_ACCEPTED")){
      const [key,revision,json]=r.values;
      if(r.formulas.some(Boolean)||typeof key!=="string"||!key.startsWith("booking:")||!Number.isSafeInteger(revision)||revision<1||typeof json!=="string")throw Error("Invalid accepted row");
      const b=crmBookingSnapshot_(JSON.parse(json));
      if(key!=="booking:"+b.id||map.has(b.id)||JSON.stringify(b)!==json)throw Error("Invalid or duplicate accepted snapshot");
      map.set(b.id,{r,revision,booking:b});
    }
    return map;
  }
  function read(id){crmId_(id);return inventory().get(id)?.booking||null;}
  function revision(id){crmId_(id);return inventory().get(id)?.revision||0;}
  function list(){return [...inventory().values()].map(x=>x.booking);}
  function compareAndWrite(id,before,desired){
    crmId_(id);const b=crmBookingSnapshot_(desired);
    if(id!==b.id)throw Error("Accepted ID mismatch");
    const old=inventory().get(id);
    if(!crmSyncEqual_(old?.booking||null,before))throw Error("Accepted compare mismatch");
    if(crmSyncEqual_(old?.booking||null,b))return;
    const row=old?.r.row||sheet.getLastRow()+1,rev=(old?.revision||0)+1;
    if(row>sheet.getMaxRows()||!Number.isSafeInteger(rev))throw Error("Accepted capacity exhausted");
    const range=sheet.getRange(row,1,1,3);
    if(range.getFormulas()[0].some(Boolean)||JSON.stringify(range.getValues()[0])!==JSON.stringify(old?.r.values||["","",""]))throw Error("Accepted row changed before write");
    range.setValues([["booking:"+id,rev,JSON.stringify(b)]]);flush();
    if(!crmSyncEqual_(read(id),b)||revision(id)!==rev)throw Error("Accepted write not verified");
  }
  return {read,list,revision,compareAndWrite};
}
