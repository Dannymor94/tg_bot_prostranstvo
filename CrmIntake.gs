// Manual-entry normalization. No writes; unresolved input must be shown to admin
// and its actual occupied interval must remain unavailable until resolved.
function crmNameKey_(value){
  return crmSheetSafeText_(value).normalize("NFC").trim().replace(/\s+/g," ").toLowerCase();
}
function crmTenantProfiles_(sheet){
  const profiles=[],ids=new Set();
  for(const r of crmSheetRows_(sheet,"Арендаторы")){
    if(r.formulas.some(Boolean))throw Error("Formula in tenant row");
    const v=r.values,id=crmId_(v[7]),name=crmSheetSafeText_(v[0]).trim(),direction=crmSheetSafeText_(v[1]).trim();
    if(!name||ids.has(id)||typeof v[3]!=="boolean")throw Error("Invalid tenant profile");
    ids.add(id);
    profiles.push({id,name,direction,format:crmSheetFormat_(v[2]),regular:v[3]});
  }
  return profiles;
}
function crmResolveTenant_(name,profiles){
  if(!Array.isArray(profiles))throw Error("Missing tenant directory");
  const key=crmNameKey_(name),seen=new Set(),matches=[];
  for(const p of profiles){
    crmId_(p.id);
    if(seen.has(p.id)||!crmNameKey_(p.name)||typeof p.regular!=="boolean"||typeof p.direction!=="string"||
       (p.format!==null&&!["individual","group"].includes(p.format)))throw Error("Invalid tenant directory");
    seen.add(p.id);
    if(crmNameKey_(p.name)===key)matches.push(p);
  }
  return matches.length===1?{kind:"resolved",tenant:matches[0]}:{kind:"review",reason:matches.length?"ambiguous_tenant":"unknown_tenant"};
}
function crmManualBooking_(input,profiles,cfg){
  crmId_(input.id);crmCivilDate_(input.date);
  if(!Number.isInteger(input.from)||!Number.isInteger(input.to)||input.from<0||input.to>=1440||input.to<=input.from)throw Error("Invalid manual interval");
  const occupied={date:input.date,from:input.from,to:input.to};
  crmValidateTariff_(cfg);
  const result=crmResolveTenant_(input.name,profiles);
  if(result.kind==="review")return {...result,occupied,name:input.name};
  const p=result.tenant;
  const direction=crmSheetSafeText_(input.direction||p.direction).trim(),format=input.format||p.format;
  if(!direction||!format)return {kind:"review",reason:"missing_booking_details",occupied,name:p.name};
  const status=input.status||"confirmed";
  if(!["draft","confirmed"].includes(status))throw Error("Invalid new booking status");
  const booking=crmBookingSnapshot_({id:input.id,...occupied,tenantId:p.id,direction,format,status});
  let quote;
  try{quote=crmQuote_({...booking,regular:p.regular},cfg);}catch(e){
    return {kind:"review",reason:"outside_tariff_or_invalid_quote",occupied,name:p.name};
  }
  return {kind:"ready",booking,quote,status,tenantName:p.name};
}
function crmManualSheetPlan_(row,profiles,cfg,id){
  if(!row||!Array.isArray(row.values)||row.values.length!==17||row.formulas.some(Boolean))throw Error("Invalid manual sheet row");
  const v=row.values;
  // New input may contain only the visible booking fields, not money or system IDs.
  if([6,7,8,10,11,12,13,14,15,16].some(i=>v[i]!==""))throw Error("Unexpected technical or financial value in new row");
  if([0,1,2,3].some(i=>v[i]===""))return {kind:"incomplete",reason:"missing_date_time_or_name"};
  return crmManualBooking_({id,date:crmSheetDate_(row.display[0]),from:crmSheetMinute_(row.display[1]),to:crmSheetMinute_(row.display[2]),
    name:v[3],direction:v[4],format:crmSheetFormat_(v[5]),status:v[9]===""?"confirmed":crmSheetStatus_(v[9])},profiles,cfg);
}
function crmManualCalendarPlan_(event,profiles,cfg,id){
  if(!event||typeof event.id!=="string"||!event.id||typeof event.etag!=="string"||!event.etag)throw Error("Missing calendar identity");
  if(event.extendedProperties?.private?.crmBookingId)throw Error("Already managed event");
  if(event.status!=="confirmed"||event.recurringEventId||event.recurrence?.length||event.attendees?.length||
     event.transparency==="transparent"||event.eventType&&event.eventType!=="default"||
     !event.start?.dateTime||!event.end?.dateTime)return {kind:"review",reason:"unsupported_calendar_event",eventId:event.id};
  const start=crmCalendarLocal_(event.start.dateTime),end=crmCalendarLocal_(event.end.dateTime);
  if(start.date!==end.date)return {kind:"review",reason:"multi_day_event",eventId:event.id};
  const title=crmSheetSafeText_(event.summary||"").trim(),occupied={date:start.date,from:start.minute,to:end.minute};
  if(!title)return {kind:"review",reason:"missing_title",occupied,eventId:event.id};
  // Exact whole name takes priority. Explicit separator supports "Name — Direction".
  let name=title,direction="";
  const exact=crmResolveTenant_(title,profiles);
  if(exact.kind!=="resolved"&&exact.reason!=="ambiguous_tenant"){
    const parts=title.split(/\s+[—–-]\s+/);
    if(parts.length===2){name=parts[0].trim();direction=parts[1].trim();}
  }
  const result=crmManualBooking_({id,...occupied,name,direction,format:null},profiles,cfg);
  return {...result,eventId:event.id,etag:event.etag};
}

// Claim an identified user-entered row only after re-reading the original content.
// The caller allocates and durably records the ID, checks availability and holds the lock.
function crmClaimManualRow_(sheet,expectedRow,profiles,cfg,id,flush){
  crmId_(id);
  if(typeof flush!=="function"||!Number.isInteger(expectedRow?.row)||expectedRow.row<2)throw Error("Invalid manual row claim");
  const planned=crmManualSheetPlan_(expectedRow,profiles,cfg,id);
  if(planned.kind!=="ready")return planned;
  const rows=crmSheetRows_(sheet,"Аренды"),existing=rows.filter(r=>r.values[11]===id);
  if(existing.length>1)throw Error("Duplicate booking identity");
  if(existing.length===1){
    const b=planned.booking,v=existing[0].values;
    const p=profiles.find(x=>x.id===b.tenantId);
    if(v[16]!==b.tenantId||crmNameKey_(v[3])!==crmNameKey_(p.name)||v[4]!==b.direction||
      crmSheetFormat_(v[5])!==b.format||crmSheetStatus_(v[9])!==b.status||
      crmSheetDate_(existing[0].display[0])!==b.date||crmSheetMinute_(existing[0].display[1])!==b.from||
      crmSheetMinute_(existing[0].display[2])!==b.to)throw Error("Claim identity already used");
    return {...planned,replayed:true};
  }
  const current=rows.find(r=>r.row===expectedRow.row);
  if(!current||JSON.stringify(current.values)!==JSON.stringify(expectedRow.values)||JSON.stringify(current.display)!==JSON.stringify(expectedRow.display)||current.formulas.some(Boolean))throw Error("Manual row changed");
  const v=current.values.slice(),b=planned.booking;
  v[3]=planned.tenantName;v[4]=b.direction;v[5]=b.format==="group"?"Групповое":"Индивидуальное";
  v[9]=b.status==="draft"?"Черновик":"Подтверждена";v[11]=id;v[16]=b.tenantId;
  // Persist initial quote with the claim, before creating a Calendar projection.
  if(b.status==="confirmed"){v[6]=planned.quote.totalKopecks/100;v[14]=planned.quote.tariffVersion;}
  for(const value of v)if(typeof value==="string")crmSheetSafeText_(value);
  const range=sheet.getRange(current.row,1,1,17);
  if(range.getFormulas()[0].some(Boolean)||JSON.stringify(range.getValues()[0])!==JSON.stringify(current.values))throw Error("Manual row changed before claim");
  range.setValues([v]);flush();
  const verified=crmSheetRows_(sheet,"Аренды").filter(r=>r.values[11]===id);
  if(verified.length!==1||JSON.stringify(verified[0].values)!==JSON.stringify(v))throw Error("Manual row claim not verified");
  return {...planned,replayed:false};
}
