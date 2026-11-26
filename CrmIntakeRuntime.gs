// Wire manual intake into TEST reconciliation. Unknown entries are left intact.
function crmUnclaimedRows_(sheet){
  return crmSheetRows_(sheet,"Аренды").filter(r=>r.values[11]==="");
}
function crmUnclaimedOverlap_(candidate,rows,ignoreRow=null){
  if(candidate.status==="cancelled")return false;
  for(const r of rows){
    if(r.row===ignoreRow)continue;
    const v=r.values;
    // An unfinished row with no complete interval is not a reservation yet.
    if([0,1,2].some(i=>v[i]===""))continue;
    if(r.formulas.some(Boolean))throw Error("Formula in unclaimed interval");
    const date=crmSheetDate_(r.display[0]),from=crmSheetMinute_(r.display[1]),to=crmSheetMinute_(r.display[2]);
    if(to<=from)throw Error("Invalid unclaimed interval");
    if(date===candidate.date&&candidate.from<to&&candidate.to>from)return true;
  }
  return false;
}
function crmIntakeSheetPass_(sheet,profiles,cfg,newId,flush,isAvailable,limit){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("Invalid intake limit");
  const report={claimed:0,review:0,incomplete:0,errors:0,limited:false};
  for(const r of crmUnclaimedRows_(sheet)){
    try{
      const plan=crmManualSheetPlan_(r,profiles,cfg,newId());
      if(plan.kind==="incomplete"){report.incomplete++;continue;}
      if(plan.kind!=="ready"||!isAvailable(plan.booking,r.row)){report.review++;continue;}
      if(report.claimed>=limit){report.limited=true;break;}
      crmClaimManualRow_(sheet,r,profiles,cfg,plan.booking.id,flush);
      report.claimed++;
    }catch(e){report.errors++;}
  }
  return report;
}
// A reversible namespace preserves existing Calendar event IDs without a second
// mapping database. Unsupported long/unusual external IDs are review-only.
function crmExternalBookingId_(eventId){
  if(typeof eventId!=="string"||!/^[a-zA-Z0-9_-]{1,120}$/.test(eventId))throw Error("Unsupported external event ID");
  return "ext_"+eventId;
}
function crmRuntimeEventId_(id){
  crmId_(id);
  return id.startsWith("ext_")?crmExternalBookingId_(id.slice(4)).slice(4):crmCalendarEventId_(id);
}
function crmAdoptCalendarEvent_(request,calendarId,event,profiles,cfg,migration=null){
  if(event.id.startsWith("crm2"))return {kind:"review",reason:"reserved_event_id"};
  const id=crmExternalBookingId_(event.id);
  const legacy=migration!==null;
  if(legacy){
    // Only the dedicated, durably staged migration path may admit this marker.
    crmLegacyApproval_(event,migration);
  }else if(event.description&&event.description.trim())return {kind:"review",reason:"existing_description"};
  const plan=crmManualCalendarPlan_(event,profiles,cfg,id);
  if(plan.kind!=="ready")return plan;
  if(legacy&&!crmSyncEqual_(plan.booking,migration.booking))throw Error("Reviewed booking differs from adoption plan");
  const path="/calendars/"+encodeURIComponent(calendarId)+"/events/"+encodeURIComponent(event.id);
  const current=request("GET",path,null,{});
  if(current.code!==200||current.body?.id!==event.id)throw Error("Calendar intake read failed");
  if(current.body.extendedProperties?.private?.crmBookingId===id){
    const actual=crmCalendarSnapshot_(current.body,id,event.id);
    if(!crmSyncEqual_(actual,plan.booking))throw Error("Adopted event changed");
    if(legacy&&current.body.extendedProperties?.private?.crmLegacyDescription!==event.description)throw Error("Legacy provenance missing");
    return {...plan,replayed:true};
  }
  if(current.body.etag!==event.etag||current.body.extendedProperties?.private?.crmBookingId||
    legacy&&crmMigrationCanonical_(current.body)!==crmMigrationCanonical_(event))throw Error("Calendar intake changed");
  const body=crmCalendarBody_(plan.booking,plan.tenantName);
  // Adoption is a metadata patch only, never move, create or delete the event.
  const patch={summary:body.summary,description:body.description,visibility:body.visibility,transparency:body.transparency,
    extendedProperties:{private:{...current.body.extendedProperties?.private,crmBookingId:id,
      ...(legacy?{crmLegacyDescription:event.description}:{})},
      ...(current.body.extendedProperties?.shared?{shared:current.body.extendedProperties.shared}:{})}};
  const result=request("PATCH",path,patch,{"If-Match":event.etag});
  if(result.code!==200)throw Error("Calendar adoption failed: "+result.code);
  const verified=request("GET",path,null,{});
  if(verified.code!==200||!crmSyncEqual_(crmCalendarSnapshot_(verified.body,id,event.id),plan.booking))throw Error("Calendar adoption not verified");
  if(legacy&&verified.body.extendedProperties?.private?.crmLegacyDescription!==event.description)throw Error("Legacy provenance not verified");
  return {...plan,replayed:false};
}
function crmIntakeCalendarPass_(request,calendarId,profiles,cfg,limit){
  if(!Number.isInteger(limit)||limit<1||limit>100)throw Error("Invalid intake limit");
  const report={adopted:0,review:0,errors:0,limited:false};
  const events=crmCalendarChanges_(request,calendarId,null).items;
  for(const event of events){
    if(event.status==="cancelled"||event.extendedProperties?.private?.crmBookingId)continue;
    if(report.adopted>=limit){report.limited=true;break;}
    try{
      const plan=crmAdoptCalendarEvent_(request,calendarId,event,profiles,cfg);
      if(plan.kind==="ready")report.adopted++;else report.review++;
    }catch(e){report.errors++;}
  }
  return report;
}
