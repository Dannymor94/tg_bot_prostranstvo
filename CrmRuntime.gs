// CRM v2 bounded reconciliation for managed records. No installation/activation here.
// Full inventory is deliberate for small TEST deployments: no cursor can lose edits.
function crmRuntimeOverlap_(candidate,other){
  return other!==null&&other.id!==candidate.id&&other.status!=="cancelled"&&other.date===candidate.date&&candidate.from<other.to&&candidate.to>other.from;
}
function crmRuntimeAvailable_(candidate,inventory,journal,calendarBusy){
  crmValidateBooking_(candidate);
  if(candidate.status==="cancelled")return true;
  if(!Array.isArray(inventory)||!Array.isArray(journal)||typeof calendarBusy!=="function")throw Error("Incomplete availability inventory");
  for(const b of inventory){crmValidateBooking_(b);if(crmRuntimeOverlap_(candidate,b))return false;}
  for(const raw of journal){
    const record=crmJournalRecord_(raw);
    if(record.status==="done")continue;
    for(const b of [record.intent.base,record.intent.sheet,record.intent.calendar,record.intent.desired])
      if(crmRuntimeOverlap_(candidate,b))return false;
  }
  const busy=calendarBusy(candidate);
  if(typeof busy!=="boolean")throw Error("Unknown Calendar occupancy");
  return !busy;
}
function crmRuntimePass_(port,limit,afterId=null){
  if(afterId!==null)crmId_(afterId);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("Invalid reconciliation limit");
  const report={completed:0,unchanged:0,conflicts:[],errors:[],pending:0,unmanaged:0,limited:false,nextAfterId:afterId};
  const initial=port.inventory(); // complete validated reads before any writes
  if(!initial||!Array.isArray(initial.ids)||!Array.isArray(initial.unmanaged))throw Error("Incomplete runtime inventory");
  report.unmanaged=initial.unmanaged.length;
  const ids=new Set();
  for(const id of initial.ids){crmId_(id);ids.add(id);}
  const history=port.list();
  if(!Array.isArray(history))throw Error("Missing journal inventory");
  const frozen=new Set(),pending=[];
  for(const raw of history){
    const r=crmJournalRecord_(raw);
    if(r.status==="done")continue;
    const id=r.intent.desired.id;
    if(frozen.has(id))throw Error("Duplicate unresolved operation");
    frozen.add(id);
    if(r.status==="pending")pending.push(r);
    else report.conflicts.push({id,reason:r.reason});
  }
  let budget=limit;
  for(const r of pending){
    if(!budget){report.limited=true;break;}
    budget--;
    try{
      const result=crmRunSync_(port,r.intent);
      if(result.status==="done")report.completed++;
      else report.conflicts.push({id:r.intent.desired.id,reason:result.reason});
    }catch(e){report.errors.push({id:r.intent.desired.id,reason:"pending_retry_failed"});}
  }
  const ordered=[...ids].sort();
  const rotated=afterId===null?ordered:[...ordered.filter(id=>id>afterId),...ordered.filter(id=>id<=afterId)];
  for(const id of rotated){
    if(frozen.has(id))continue; // do not generate another operation in same pass after replay
    if(!budget){report.limited=true;break;}
    budget--;report.nextAfterId=id;
    try{
      const base=port.read("accepted",id),sheet=port.read("sheet",id),calendar=port.read("calendar",id);
      if(base===null&&sheet===null&&calendar===null)continue;
      if(base!==null&&crmSyncEqual_(base,sheet)&&crmSyncEqual_(base.status==="cancelled"?null:base,calendar)){
        if(base.status!=="cancelled"&&port.normalizeCalendar)port.normalizeCalendar(id,base);
        report.unchanged++;continue;
      }
      const planned=crmSyncIntent_({id:port.newId(),base,sheet,calendar,calendarDeleted:base!==null&&base.status!=="cancelled"&&calendar===null});
      if(planned.kind==="conflict"){report.conflicts.push({id,reason:planned.fields.join(",")});continue;}
      const result=crmRunSync_(port,planned.intent);
      if(result.status==="done"){
        report.completed++;
        if(result.intent.desired.status!=="cancelled"&&port.normalizeCalendar)port.normalizeCalendar(id,result.intent.desired);
      }else report.conflicts.push({id,reason:result.reason});
    }catch(e){report.errors.push({id,reason:"reconciliation_failed"});}
  }
  report.pending=port.list().filter(r=>r.status==="pending").length;
  report.ok=!report.limited&&!report.unmanaged&&!report.pending&&!report.errors.length&&!report.conflicts.length;
  return report;
}
function crmCalendarBusy_(request,calendarId,candidate,ownEventId){
  crmValidateBooking_(candidate);
  if(candidate.status==="cancelled")return false;
  const start=crmCalendarTime_(candidate.date,candidate.from),end=crmCalendarTime_(candidate.date,candidate.to);
  const prefix="/calendars/"+encodeURIComponent(calendarId)+"/events";
  const tokens=new Set(),ids=new Set();let page=null,busy=false;
  for(let i=0;i<100;i++){
    const query=["singleEvents=true","showDeleted=false","maxResults=250","timeMin="+encodeURIComponent(start),"timeMax="+encodeURIComponent(end)];
    if(page)query.push("pageToken="+encodeURIComponent(page));
    const r=request("GET",prefix+"?"+query.join("&"),null,{});
    if(r.code!==200||!Array.isArray(r.body?.items))throw Error("Calendar availability unavailable");
    for(const e of r.body.items){
      if(!e||typeof e.id!=="string"||!e.id||ids.has(e.id))throw Error("Invalid availability event");
      ids.add(e.id);
      if(e.id===ownEventId&&e.extendedProperties?.private?.crmBookingId===candidate.id)continue;
      if(e.status==="cancelled"||e.transparency==="transparent")continue;
      // The API query already filters overlapping events, including expanded
      // recurrence and all-day events. Treat any other returned event as occupied.
      busy=true;
    }
    page=r.body.nextPageToken;
    if(!page)return busy;
    if(typeof page!=="string"||tokens.has(page))throw Error("Invalid availability pagination");
    tokens.add(page);
  }
  throw Error("Availability page limit exceeded");
}
function crmRuntimePort_(sheet,accepted,journal,request,calendarId,tenantName,newId,unclaimedRows=()=>[],resolveTitle){
  if(typeof newId!=="function")throw Error("Missing operation ID allocator");
  function discovery(){
    const result=crmCalendarChanges_(request,calendarId,null),map=new Map(),unmanaged=[];
    for(const e of result.items){
      if(e.status==="cancelled")continue;
      const id=e.extendedProperties?.private?.crmBookingId;
      if(!id){unmanaged.push(e.id);continue;}
      crmId_(id);
      if(map.has(id))throw Error("Duplicate managed Calendar identity");
      // Imported IDs require explicit durable mapping; do not guess them.
      if(e.id!==crmRuntimeEventId_(id))throw Error("Unregistered imported Calendar event");
      map.set(id,e.id);
    }
    return {map,unmanaged};
  }
  const cal=crmCalendarPort_(request,calendarId,tenantName,crmRuntimeEventId_,resolveTitle);
  const targets={sheet,accepted,calendar:cal};
  const inventory=()=>{
    const d=discovery(),ids=[...new Set([...sheet.list().map(b=>b.id),...accepted.list().map(b=>b.id),...d.map.keys()])];
    return {ids,unmanaged:d.unmanaged};
  };
  const isAvailable=(b,ignoreRow=null)=>!crmUnclaimedOverlap_(b,unclaimedRows(),ignoreRow)&&crmRuntimeAvailable_(b,[...sheet.list(),...accepted.list()],journal.list(),x=>crmCalendarBusy_(request,calendarId,x,crmRuntimeEventId_(x.id)));
  return {...journal,newId,inventory,isAvailable,
    normalizeCalendar(id,b){return cal.normalize(id,b);},
    read(target,id){if(!targets[target])throw Error("Unknown target");return targets[target].read(id);},
    compareAndWrite(target,id,before,desired,initialQuote=null){
      if(!targets[target])throw Error("Unknown target");
      if(target==="calendar"&&desired!==null&&!isAvailable(desired))throw Error("Calendar occupancy changed");
      if(initialQuote!==null&&target!=="sheet")throw Error("Initial quote requires Sheet creation");
      return targets[target].compareAndWrite(id,before,desired,initialQuote);
    }};
}
