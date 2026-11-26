// Explicit TEST migration. Staging is an archive, not a confirmed booking/receipt.
function crmLegacyMarker_(){
  return "[STUDIO_BIDIR_V1] Imported from test booking Sheet; edits synchronize both ways.";
}
function crmMigrationCanonical_(value){
  const sort=v=>Array.isArray(v)?v.map(sort):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;
  return JSON.stringify(sort(value));
}
function crmLegacyApproval_(event,approval){
  if(!approval||approval.schema!==1||approval.approved!==true||approval.eventId!==event.id||
    approval.etag!==event.etag||approval.description!==event.description||event.description!==crmLegacyMarker_())throw Error("Legacy migration requires exact reviewed snapshot");
  if(!approval.booking)throw Error("Reviewed booking details required");
  const b=crmBookingSnapshot_(approval.booking),start=crmCalendarLocal_(event.start?.dateTime),end=crmCalendarLocal_(event.end?.dateTime);
  if(b.id!==crmExternalBookingId_(event.id)||b.status!=="confirmed"||b.date!==start.date||b.date!==end.date||b.from!==start.minute||b.to!==end.minute)throw Error("Reviewed interval mismatch");
  return b;
}
function crmMigrationHeaders_(){return ["Calendar ID","Status","Original event JSON","Reviewed booking JSON","Reason"];}
function crmMigrationRows_(sheet){
  if(!sheet||sheet.getName()!=="_CRM_MIGRATION"||sheet.getLastColumn()!==5)throw Error("Wrong migration sheet");
  const range=sheet.getRange(1,1,Math.max(1,sheet.getLastRow()),5),rows=range.getValues();
  if(JSON.stringify(rows[0])!==JSON.stringify(crmMigrationHeaders_())||range.getFormulas().some(r=>r.some(Boolean)))throw Error("Invalid migration schema");
  const seen=new Set();
  return rows.slice(1).map((v,i)=>{
    if(typeof v[0]!=="string"||seen.has(v[0])||!["REVIEW","APPROVED","PENDING","DONE"].includes(v[1])||typeof v[2]!=="string"||typeof v[3]!=="string")throw Error("Invalid migration row");
    seen.add(v[0]);const event=JSON.parse(v[2]);
    if(event.id!==v[0]||!event.etag||!event.start||!event.end)throw Error("Invalid migration event");
    return {row:i+2,values:v,event};
  });
}
function crmMigrationSet_(sheet,row,next,flush){
  const range=sheet.getRange(row.row,1,1,5);
  if(range.getFormulas()[0].some(Boolean)||JSON.stringify(range.getValues()[0])!==JSON.stringify(row.values))throw Error("Migration row changed");
  range.setValues([next]);flush();
  if(JSON.stringify(range.getValues()[0])!==JSON.stringify(next))throw Error("Migration write not verified");
}
function crmMigrationGuard_(env){
  const binding=JSON.parse(env.props.getProperty("CRM_V2_BINDING"));
  const handover=JSON.parse(env.props.getProperty("CRM_V2_LEGACY_HANDOVER")||"null");
  if(!handover||handover.mode!=="TEST"||handover.stopped!==true||!handover.scriptId||!Number.isFinite(Date.parse(handover.at))||
    handover.calendarId!==binding.calendarId||handover.spreadsheetId!==binding.spreadsheetId)throw Error("Verified TEST writer handover required");
  if(env.props.getProperty("CRM_V2_MIGRATION_TEST_ENABLED")!=="true")throw Error("Migration disabled");
  const latest=JSON.parse(env.props.getProperty("CRM_V2_LAST_BACKUP")||"null");
  if(!latest||latest.folderId!==env.props.getProperty("CRM_V2_BACKUP_FOLDER_ID")||
    latest.date!==Utilities.formatDate(new Date(),"Europe/Moscow","yyyy-MM-dd")||Date.parse(latest.at)<Date.parse(handover.at))throw Error("Fresh post-handover backup required");
  return crmBackupVerify_(DriveApp.getFolderById(latest.folderId),latest.manifestId,binding);
}
function crmV2StageLegacyTest(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw Error("System busy");
  try{
    const env=crmV2BoundTest_(),backup=crmMigrationGuard_(env),book=env.sheets["Аренды"].getParent();
    let sheet=book.getSheetByName("_CRM_MIGRATION");
    if(!sheet){sheet=book.insertSheet("_CRM_MIGRATION");sheet.getRange(1,1,1,5).setValues([crmMigrationHeaders_()]);sheet.hideSheet();env.flush();}
    const existing=new Map(crmMigrationRows_(sheet).map(r=>[r.event.id,r]));
    const events=crmCalendarChanges_(crmGasCalendarRequest_,env.calendarId,null).items;
    const saved=new Map(backup.events.map(e=>[e.id,e]));
    const report={staged:0,existing:0,review:0};
    for(const event of events){
      if(event.status==="cancelled")continue;
      if(existing.has(event.id)){report.existing++;continue;}
      if(crmMigrationCanonical_(saved.get(event.id))!==crmMigrationCanonical_(event))throw Error("Calendar changed since backup");
      const json=JSON.stringify(event);if(json.length>45000)throw Error("Event archive exceeds cell capacity");
      const reason=event.description===crmLegacyMarker_()?"review_details_and_staged_source":"unrecognized_description";
      const row=sheet.getLastRow()+1;if(row>sheet.getMaxRows())throw Error("Migration capacity exhausted");
      const values=[event.id,"REVIEW",json,"",reason];
      crmMigrationSet_(sheet,{row,values:Array(5).fill("")},values,env.flush);
      report.staged++;report.review++;
    }
    console.log(JSON.stringify(report));return report;
  }finally{lock.releaseLock();}
}
function crmV2ImportReviewedLegacyTest(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw Error("System busy");
  try{
    const env=crmV2BoundTest_();crmMigrationGuard_(env);
    if(env.props.getProperty("CRM_V2_TEST_WRITE_ENABLED")!=="true")throw Error("CRM v2 TEST writes disabled");
    const sheet=env.sheets["Аренды"].getParent().getSheetByName("_CRM_MIGRATION"),rows=crmMigrationRows_(sheet);
    const report={imported:0,held:0};
    for(const row of rows){
      if(row.values[1]==="REVIEW"||row.values[1]==="DONE"){report.held+=row.values[1]==="REVIEW"?1:0;continue;}
      if(report.imported>=5)break;
      const event=row.event,booking=crmBookingSnapshot_(JSON.parse(row.values[3]));
      const approval={schema:1,approved:true,eventId:event.id,etag:event.etag,description:event.description,booking};
      crmLegacyApproval_(event,approval);
      // Explicit reviewed values must also agree with the current tenant directory.
      const plan=crmManualCalendarPlan_(event,env.profiles,env.tariff,booking.id);
      if(plan.kind!=="ready"||!crmSyncEqual_(plan.booking,booking))throw Error("Reviewed details do not match tenant directory");
      const next=row.values.slice();next[1]="PENDING";next[4]="metadata_then_sync";
      crmMigrationSet_(sheet,row,next,env.flush);
      crmAdoptCalendarEvent_(crmGasCalendarRequest_,env.calendarId,event,env.profiles,env.tariff,approval);
      const planned=crmSyncIntent_({id:"mig_"+event.id,base:null,sheet:null,calendar:booking,calendarDeleted:false});
      const result=crmRunSync_(env.port,planned.intent);
      if(result.status!=="done")throw Error("Migration held by synchronization conflict");
      const done=next.slice();done[1]="DONE";done[4]="quote_and_payment_not_imported";
      crmMigrationSet_(sheet,{row:row.row,values:next},done,env.flush);report.imported++;
    }
    console.log(JSON.stringify(report));return report;
  }finally{lock.releaseLock();}
}
