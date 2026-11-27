// Persistent Sheets journal adapter (not wired to deployed GAS). Caller holds lock and checks binding.
function crmJournalHeaders_(){return ["Operation ID","Booking ID","Status","Intent JSON","Reason"];}

function crmJournalRecord_(record){
  if(!record||typeof record!=="object")throw Error("Invalid journal record");
  const intent=crmValidateSyncIntent_(record.intent);
  if(!["pending","done","conflict"].includes(record.status))throw Error("Invalid journal status");
  if(record.status==="conflict"){
    if(typeof record.reason!=="string"||!/^(overlap|changed_(?:after_write_)?(?:sheet|calendar|accepted))$/.test(record.reason))throw Error("Invalid conflict reason");
  }else if(record.reason!==undefined)throw Error("Unexpected reason");
  return {intent,status:record.status,...(record.status==="conflict"?{reason:record.reason}:{})};
}

function crmJournalForSheet_(sheet,flush){
  // Internal adapter only. Caller must supply the explicitly bound TEST sheet
  // and hold the shared script lock; never call on the existing v1 spreadsheet.
  if(!sheet||sheet.getName()!=="_CRM_JOURNAL"||typeof flush!=="function")throw Error("Invalid journal target");
  const headers=crmJournalHeaders_();
  function rows(){
    const n=sheet.getLastRow();
    if(n<1||n>20001||sheet.getLastColumn()!==headers.length)throw Error("Invalid journal dimensions");
    const range=sheet.getRange(1,1,n,headers.length);
    const values=range.getValues();
    if(range.getFormulas().some(r=>r.some(Boolean)))throw Error("Unexpected formula in journal");
    if(JSON.stringify(values[0])!==JSON.stringify(headers))throw Error("Journal schema mismatch");
    const found=new Map();
    for(let i=1;i<values.length;i++){
      const [op,booking,status,json,reason]=values[i];
      if(typeof json!=="string")throw Error("Invalid journal payload");
      const record=crmJournalRecord_({intent:JSON.parse(json),status,...(reason===""?{}:{reason})});
      if(op!=="op:"+record.intent.id||booking!=="booking:"+record.intent.desired.id||found.has(record.intent.id))throw Error("Invalid or duplicate journal identity");
      found.set(record.intent.id,{row:i+1,record});
    }
    return found;
  }
  function load(id){crmId_(id);return rows().get(id)?.record||null;}
  function hasPending(bookingId){
    crmId_(bookingId);
    return [...rows().values()].some(x=>x.record.intent.desired.id===bookingId&&x.record.status!=="done");
  }
  function save(raw){
    const record=crmJournalRecord_(raw),id=record.intent.id,inventory=rows(),prior=inventory.get(id);
    if(prior){
      if(JSON.stringify(prior.record.intent)!==JSON.stringify(record.intent))throw Error("Operation ID reused");
      if(JSON.stringify(prior.record)===JSON.stringify(record))return;
      if(prior.record.status!=="pending"||record.status==="pending")throw Error("Invalid journal transition");
      // Write status, unchanged intent and reason in one range. Verify after flush.
      sheet.getRange(prior.row,3,1,3).setValues([[record.status,JSON.stringify(record.intent),record.reason||""]]);
    }else{
      if(record.status!=="pending"||inventory.size>=20000)throw Error("Cannot create journal record");
      if([...inventory.values()].some(x=>x.record.intent.desired.id===record.intent.desired.id&&x.record.status!=="done"))throw Error("Booking already has unresolved operation");
      const row=inventory.size+2;
      if(row>sheet.getMaxRows())throw Error("Journal capacity exhausted");
      sheet.getRange(row,1,1,5).setValues([["op:"+id,"booking:"+record.intent.desired.id,record.status,JSON.stringify(record.intent),""]]);
    }
    flush();
    if(JSON.stringify(load(id))!==JSON.stringify(record))throw Error("Journal write not verified");
  }
  // Explicit operator retry only. Regular save() still prohibits reopening.
  function reopen(expected){
    const record=crmJournalRecord_(expected);
    if(record.status!=="conflict")throw Error("Retry requires conflict record");
    const prior=rows().get(record.intent.id);
    if(!prior||JSON.stringify(prior.record)!==JSON.stringify(record))throw Error("Conflict changed");
    const target=sheet.getRange(prior.row,3,1,3);
    if(target.getFormulas()[0].some(Boolean)||JSON.stringify(target.getValues()[0])!==JSON.stringify(["conflict",JSON.stringify(record.intent),record.reason]))throw Error("Conflict row changed");
    const pending={intent:record.intent,status:"pending"};
    target.setValues([["pending",JSON.stringify(record.intent),""]]);flush();
    if(JSON.stringify(load(record.intent.id))!==JSON.stringify(pending))throw Error("Retry not verified");
    return pending;
  }
  function list(){return [...rows().values()].map(x=>x.record);}
  return {load,hasPending,save,list,reopen};
}
