// Isolated TEST backups. No credentials, no live restore, no legacy writes.
// A successful backup includes a native workbook copy and a checksummed
// Calendar/operational-state bundle. The manifest is written last.
function crmBackupState_(properties){
  const out={};
  for(const key of Object.keys(properties).sort()){
    if(/^(CRM_TG_CMD_\d+|TG_OUTBOX_\d+|TG_OFFSET|CRM_V2_SCAN_AFTER)$/.test(key)){
      if(typeof properties[key]!=="string")throw Error("Invalid backup state");
      out[key]=properties[key];
    }
  }
  return out;
}
function crmBackupRetention_(dates,today){
  crmCivilDate_(today);
  const unique=[...new Set(dates)].sort().reverse();
  for(const d of unique){crmCivilDate_(d);if(d>today)throw Error("Future backup date");}
  const keep=new Set(unique.slice(0,14)),months=new Set();
  for(const d of unique){
    const month=d.slice(0,7);
    if(months.has(month))continue;
    if(months.size>=12)break;
    months.add(month);keep.add(d);
  }
  return {keep:[...keep].sort(),eligible:unique.filter(d=>!keep.has(d)).sort()};
}
function crmBackupPayload_(snapshot){
  if(!snapshot||snapshot.schema!==1||typeof snapshot.spreadsheetId!=="string"||!snapshot.spreadsheetId||
     typeof snapshot.calendarId!=="string"||!snapshot.calendarId||snapshot.calendarId==="primary"||
     snapshot.timeZone!=="Europe/Moscow"||!Array.isArray(snapshot.events)||!snapshot.state||typeof snapshot.state!=="object"||Array.isArray(snapshot.state))throw Error("Invalid backup payload");
  crmCivilDate_(snapshot.date);
  const ids=new Set();
  for(const e of snapshot.events){
    if(!e||typeof e.id!=="string"||!e.id||ids.has(e.id))throw Error("Invalid backup event identity");
    ids.add(e.id);
  }
  if(JSON.stringify(crmBackupState_(snapshot.state))!==JSON.stringify(snapshot.state))throw Error("Unexpected operational state");
  return JSON.stringify(snapshot);
}
function crmBackupDigest_(text){
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(x=>((x+256)%256).toString(16).padStart(2,"0")).join("");
}
function crmBackupWorkbookDigest_(book){
  const data=book.getSheets().map(sheet=>{
    const range=sheet.getDataRange(),values=range.getValues(),formulas=range.getFormulas();
    return [sheet.getName(),values.map((row,i)=>row.map((v,j)=>formulas[i][j]?["formula",formulas[i][j]]:["value",v]))];
  });
  return crmBackupDigest_(JSON.stringify(data));
}
function crmBackupPrivate_(item){
  // Restrict generated backups to My Drive, owner-only. Refuse shared folders.
  if(item.getSharingAccess()!==DriveApp.Access.PRIVATE||item.getEditors().length||item.getViewers().length||!item.getOwner())throw Error("Backup target is not owner-only");
}
function crmV2BackupTest(){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))throw Error("System busy");
  try{
    const env=crmV2BoundTest_(),props=env.props;
    if(props.getProperty("CRM_V2_BACKUP_TEST_ENABLED")!=="true")throw Error("TEST backup disabled");
    const binding=JSON.parse(props.getProperty("CRM_V2_BINDING"));
    const folderId=props.getProperty("CRM_V2_BACKUP_FOLDER_ID");
    if(!folderId)throw Error("Private backup folder required");
    const folder=DriveApp.getFolderById(folderId);crmBackupPrivate_(folder);
    const date=Utilities.formatDate(new Date(),"Europe/Moscow","yyyy-MM-dd");
    const latest=JSON.parse(props.getProperty("CRM_V2_LAST_BACKUP")||"null");
    if(latest?.date===date&&latest.spreadsheetId===binding.spreadsheetId&&latest.calendarId===binding.calendarId&&latest.folderId===folderId){
      const verified=crmBackupVerify_(folder,latest.manifestId,binding);
      return {ok:true,date,reused:true,events:verified.events.length};
    }
    SpreadsheetApp.flush();
    const before=crmCalendarChanges_(crmGasCalendarRequest_,binding.calendarId,null);
    const state=crmBackupState_(props.getProperties());
    const payload={schema:1,date,spreadsheetId:binding.spreadsheetId,calendarId:binding.calendarId,timeZone:"Europe/Moscow",events:before.items,state};
    const json=crmBackupPayload_(payload),sha=crmBackupDigest_(json);
    const source=DriveApp.getFileById(binding.spreadsheetId);
    if(source.isTrashed())throw Error("Source trashed");
    const sourceModified=source.getLastUpdated().getTime();
    const sourceBook=SpreadsheetApp.openById(source.getId()),workbookHash=crmBackupWorkbookDigest_(sourceBook);
    const tag="CRM-v2-TEST-"+date+"-"+Utilities.getUuid();
    const copy=source.makeCopy(tag+"-sheet",folder);crmBackupPrivate_(copy);
    if(copy.getId()===source.getId())throw Error("Backup must be distinct");
    const workbook=SpreadsheetApp.openById(copy.getId()),original=SpreadsheetApp.openById(source.getId());
    const shape=b=>JSON.stringify(b.getSheets().map(s=>[s.getName(),s.getMaxRows(),s.getMaxColumns()]));
    if(crmBackupWorkbookDigest_(workbook)!==workbookHash||crmBackupWorkbookDigest_(original)!==workbookHash)throw Error("Backup workbook content mismatch");
    if(shape(workbook)!==shape(original))throw Error("Backup workbook structure mismatch");
    const after=crmCalendarChanges_(crmGasCalendarRequest_,binding.calendarId,null);
    const canonical=items=>JSON.stringify(items.map(x=>[x.id,x.etag||null,x.status||null]).sort((a,b)=>a[0].localeCompare(b[0])));
    if(source.getLastUpdated().getTime()!==sourceModified||canonical(before.items)!==canonical(after.items)||JSON.stringify(crmBackupState_(props.getProperties()))!==JSON.stringify(state))throw Error("Source changed during backup; retry");
    const bundle=folder.createFile(Utilities.newBlob(json,"application/json",tag+"-calendar.json"));crmBackupPrivate_(bundle);
    const manifest={schema:1,date,spreadsheetId:binding.spreadsheetId,calendarId:binding.calendarId,folderId,copyId:copy.getId(),bundleId:bundle.getId(),sha256:sha,events:before.items.length,shape:shape(workbook),workbookHash};
    const file=folder.createFile(Utilities.newBlob(JSON.stringify(manifest),"application/json",tag+"-manifest.json"));crmBackupPrivate_(file);
    crmBackupVerify_(folder,file.getId(),binding);
    props.setProperty("CRM_V2_LAST_BACKUP",JSON.stringify({...manifest,manifestId:file.getId(),at:new Date().toISOString()}));
    return {ok:true,date,reused:false,events:before.items.length};
  }finally{lock.releaseLock();}
}
function crmBackupVerify_(folder,manifestId,binding){
  crmBackupPrivate_(folder);
  const read=id=>{
    const file=DriveApp.getFileById(id);crmBackupPrivate_(file);
    const parents=file.getParents();let inside=false;
    while(parents.hasNext())if(parents.next().getId()===folder.getId())inside=true;
    if(!inside||file.isTrashed())throw Error("Backup file outside private folder");
    return file;
  };
  const m=JSON.parse(read(manifestId).getBlob().getDataAsString("UTF-8"));
  if(m.schema!==1||m.folderId!==folder.getId()||m.spreadsheetId!==binding.spreadsheetId||m.calendarId!==binding.calendarId||m.copyId===binding.spreadsheetId)throw Error("Backup binding mismatch");
  const json=read(m.bundleId).getBlob().getDataAsString("UTF-8");
  if(crmBackupDigest_(json)!==m.sha256)throw Error("Backup checksum mismatch");
  const payload=JSON.parse(json);crmBackupPayload_(payload);
  if(payload.spreadsheetId!==m.spreadsheetId||payload.calendarId!==m.calendarId||payload.date!==m.date||payload.events.length!==m.events)throw Error("Backup payload mismatch");
  const copy=read(m.copyId),book=SpreadsheetApp.openById(copy.getId());
  if(JSON.stringify(book.getSheets().map(s=>[s.getName(),s.getMaxRows(),s.getMaxColumns()]))!==m.shape)throw Error("Backup structure mismatch");
  if(crmBackupWorkbookDigest_(book)!==m.workbookHash)throw Error("Backup workbook checksum mismatch");
  return {manifest:m,events:payload.events,state:payload.state};
}
function crmV2VerifyBackupTest(){
  const env=crmV2BoundTest_(),binding=JSON.parse(env.props.getProperty("CRM_V2_BINDING"));
  const latest=JSON.parse(env.props.getProperty("CRM_V2_LAST_BACKUP")||"null");
  if(!latest||latest.folderId!==env.props.getProperty("CRM_V2_BACKUP_FOLDER_ID"))throw Error("No verified backup");
  const result=crmBackupVerify_(DriveApp.getFolderById(latest.folderId),latest.manifestId,binding);
  return {ok:true,date:result.manifest.date,events:result.events.length,operationalEntries:Object.keys(result.state).length};
}

// Restore rehearsal only: copy a verified backup into the same private folder,
// never replace either active workbook or Calendar. Calendar payload is verified
// but not reinserted by this operation; actual restore needs a fresh target.
function crmV2RestoreWorkbookTest(){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))throw Error("System busy");
  try{
    const env=crmV2BoundTest_(),props=env.props,binding=JSON.parse(props.getProperty("CRM_V2_BINDING"));
    if(props.getProperty("CRM_V2_RESTORE_TEST_ENABLED")!=="true")throw Error("Restore rehearsal disabled");
    const latest=JSON.parse(props.getProperty("CRM_V2_LAST_BACKUP")||"null");
    if(!latest||latest.folderId!==props.getProperty("CRM_V2_BACKUP_FOLDER_ID"))throw Error("No backup");
    const folder=DriveApp.getFolderById(latest.folderId),backup=crmBackupVerify_(folder,latest.manifestId,binding);
    const file=DriveApp.getFileById(backup.manifest.copyId).makeCopy("RESTORE-TEST-"+backup.manifest.date+"-"+Utilities.getUuid(),folder);
    crmBackupPrivate_(file);
    if([binding.spreadsheetId,backup.manifest.copyId].includes(file.getId()))throw Error("Restore not isolated");
    const restored=SpreadsheetApp.openById(file.getId());
    if(JSON.stringify(restored.getSheets().map(s=>[s.getName(),s.getMaxRows(),s.getMaxColumns()]))!==backup.manifest.shape)throw Error("Restore shape mismatch");
    if(crmBackupWorkbookDigest_(restored)!==backup.manifest.workbookHash)throw Error("Restore checksum mismatch");
    const journal=crmJournalForSheet_(restored.getSheetByName("_CRM_JOURNAL"),()=>{throw Error("Read-only restore");});
    const accepted=crmAcceptedPort_(restored.getSheetByName("_CRM_ACCEPTED"),()=>{throw Error("Read-only restore");});
    const payments=crmPaymentPort_(restored.getSheetByName("Оплаты"),()=>{throw Error("Read-only restore");});
    const tariff=crmReadSettings_(restored.getSheetByName("Настройки"));
    const tenants=crmTenantProfiles_(restored.getSheetByName("Арендаторы"));
    return {ok:true,restoredSpreadsheetId:file.getId(),calendarEventsVerified:backup.events.length,
      accepted:accepted.list().length,journal:journal.list().length,payments:payments.list().length,tenants:tenants.length,tariffVersion:tariff.version};
  }finally{lock.releaseLock();}
}
