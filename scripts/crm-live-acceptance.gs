// Explicit operator-run TEST acceptance. Not included in the normal v2 bundle.
function crmAcceptanceSetupTest(){
  const env=crmV2BoundTest_(),p=env.props;
  if(!JSON.parse(p.getProperty("CRM_V2_LEGACY_HANDOVER")||"null")?.stopped)throw Error("Verify and record old TEST writer handover first");
  for(const key of ["CRM_V2_TELEGRAM_TEST_ENABLED","CRM_V2_TELEGRAM_WRITE_ENABLED","CRM_V2_RECURRING_TEST_ENABLED","CRM_V2_PAYMENT_INTENTS_TEST_ENABLED"])if(p.getProperty(key)==="true")throw Error("Other writers must stay off");
  let folderId=p.getProperty("CRM_V2_BACKUP_FOLDER_ID");
  if(!folderId){const f=DriveApp.createFolder("CRM v2 TEST backups");crmBackupPrivate_(f);folderId=f.getId();p.setProperty("CRM_V2_BACKUP_FOLDER_ID",folderId);}
  p.setProperty("CRM_V2_BACKUP_TEST_ENABLED","true");p.setProperty("CRM_V2_MIGRATION_TEST_ENABLED","true");
  const backup=crmV2BackupTest(),verified=crmV2VerifyBackupTest();
  console.log(JSON.stringify({backup,verified}));return {backup,verified};
}
function crmAcceptanceEnv_(){
  const env=crmV2BoundTest_();crmMigrationGuard_(env);
  if(env.props.getProperty("CRM_V2_LIVE_ACCEPTANCE_ENABLED")!=="true"||env.props.getProperty("CRM_V2_TEST_WRITE_ENABLED")!=="true")throw Error("Live TEST acceptance disabled");
  for(const key of ["CRM_V2_TELEGRAM_TEST_ENABLED","CRM_V2_TELEGRAM_WRITE_ENABLED","CRM_V2_RECURRING_TEST_ENABLED","CRM_V2_PAYMENT_INTENTS_TEST_ENABLED"])if(env.props.getProperty(key)==="true")throw Error("Other writers must stay off");
  return env;
}
function crmAcceptanceHash_(env,ignore=[]){
  const events=crmCalendarChanges_(crmGasCalendarRequest_,env.calendarId,null).items.filter(e=>!ignore.includes(e.id)).sort((a,b)=>a.id.localeCompare(b.id));
  return crmBackupDigest_(crmMigrationCanonical_(events));
}
function crmAcceptanceState_(env){
  const s=JSON.parse(env.props.getProperty("CRM_V2_LIVE_ACCEPTANCE_STATE")||"null");
  if(!s||s.schema!==1||!s.booking.id.startsWith("e2e_")||!s.booking.tenantId.startsWith("e2e_t_"))throw Error("Synthetic fixture state missing");
  crmValidateBooking_(s.booking);return s;
}
function crmAcceptanceSave_(env,s){env.props.setProperty("CRM_V2_LIVE_ACCEPTANCE_STATE",JSON.stringify(s));}
function crmAcceptanceSync_(env,id,base,sheet,calendar){
  const plan=crmSyncIntent_({id,base,sheet,calendar,calendarDeleted:base!==null&&base.status!=="cancelled"&&calendar===null});
  if(plan.kind!=="intent")throw Error("Unexpected synthetic conflict");
  const r=crmRunSync_(env.port,plan.intent);if(r.status!=="done")throw Error("Synthetic sync held: "+r.reason);return plan.intent;
}
function crmAcceptanceCreateTest(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw Error("Busy");
  try{
    let env=crmAcceptanceEnv_(),s=JSON.parse(env.props.getProperty("CRM_V2_LIVE_ACCEPTANCE_STATE")||"null");
    if(!s){
      const token=Utilities.getUuid().replace(/-/g,"");
      const booking={id:"e2e_"+token,date:"2027-01-03",from:750,to:810,tenantId:"e2e_t_"+token,direction:"Синтетический E2E",format:"group",status:"confirmed"};
      if(!env.port.isAvailable(booking))throw Error("Synthetic interval occupied");
      s={schema:1,booking,name:"ТЕСТ E2E "+token,phase:0,originalHash:crmAcceptanceHash_(env),ledgerHash:crmBackupDigest_(crmMigrationCanonical_(env.payments.list())),legacyEventId:"e2e"+token,startedAt:new Date().toISOString()};
      crmAcceptanceSave_(env,s);
    }
    s=crmAcceptanceState_(env);
    if(s.phase>0){console.log(JSON.stringify({create:"already_done",phase:s.phase}));return;}
    const tenants=crmSheetRows_(env.sheets["Арендаторы"],"Арендаторы"),existing=tenants.filter(r=>r.values[7]===s.booking.tenantId);
    const values=[s.name,s.booking.direction,"Групповое","Внутренний","","","Искусственный тест; не клиент",s.booking.tenantId];
    if(existing.length>1||existing.length===1&&JSON.stringify(existing[0].values)!==JSON.stringify(values))throw Error("Synthetic tenant collision");
    if(!existing.length){const sh=env.sheets["Арендаторы"],n=sh.getLastRow()+1;if(n>sh.getMaxRows())throw Error("No fixture capacity");sh.getRange(n,1,1,8).setValues([values]);env.flush();}
    env=crmAcceptanceEnv_();
    const current=env.port.read("sheet",s.booking.id);
    if(current===null)env.port.compareAndWrite("sheet",s.booking.id,null,s.booking);
    else if(!crmSyncEqual_(current,s.booking))throw Error("Synthetic Sheet changed");
    s.createIntent=crmAcceptanceSync_(env,"create_"+s.booking.id,null,s.booking,null);s.phase=1;crmAcceptanceSave_(env,s);
    console.log(JSON.stringify({create:"PASS",acceptedRevision:env.accepted.revision(s.booking.id),calendarEventsAdded:1}));
  }finally{lock.releaseLock();}
}
function crmAcceptanceMoveTest(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw Error("Busy");
  try{
    const env=crmAcceptanceEnv_(),s=crmAcceptanceState_(env);if(s.phase!==1)throw Error("Create phase required");
    const moved={...s.booking,from:810,to:870},current=env.port.read("calendar",s.booking.id);
    if(crmSyncEqual_(current,s.booking))env.port.compareAndWrite("calendar",s.booking.id,s.booking,moved);
    else if(!crmSyncEqual_(current,moved))throw Error("Synthetic Calendar changed");
    s.moveIntent=crmAcceptanceSync_(env,"move_"+s.booking.id,s.booking,s.booking,moved);s.moved=moved;s.phase=2;crmAcceptanceSave_(env,s);
    // A distinct booking at the same interval must fail availability.
    if(env.port.isAvailable({...moved,id:"collision_"+s.booking.id}))throw Error("Overlap protection failed");
    console.log(JSON.stringify({calendarMoveToSheet:"PASS",overlapRejection:"PASS",acceptedRevision:env.accepted.revision(s.booking.id)}));
  }finally{lock.releaseLock();}
}
function crmAcceptanceLegacyTest(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw Error("Busy");
  try{
    const env=crmAcceptanceEnv_(),s=crmAcceptanceState_(env);if(s.phase!==2)throw Error("Move phase required");
    const path="/calendars/"+encodeURIComponent(env.calendarId)+"/events/"+s.legacyEventId;
    if(!s.legacyOriginal){
      let r=crmGasCalendarRequest_("GET",path,null,{});
      if(r.code===404||r.code===410){
        const candidate={...s.booking,id:"ext_"+s.legacyEventId,from:900,to:960};
        if(!env.port.isAvailable(candidate))throw Error("Synthetic legacy interval occupied");
        const body={id:s.legacyEventId,summary:s.name,description:crmLegacyMarker_(),start:{dateTime:crmCalendarTime_(candidate.date,candidate.from)},end:{dateTime:crmCalendarTime_(candidate.date,candidate.to)},visibility:"private",transparency:"opaque",colorId:"3"};
        r=crmGasCalendarRequest_("POST",path.slice(0,path.lastIndexOf('/')),body,{});if(![200,201].includes(r.code))throw Error("Synthetic legacy seed failed");
        r=crmGasCalendarRequest_("GET",path,null,{});
      }
      if(r.code!==200||r.body.summary!==s.name||r.body.description!==crmLegacyMarker_())throw Error("Synthetic seed collision");
      s.legacyOriginal=r.body;crmAcceptanceSave_(env,s); // durable before metadata mutation
    }
    const e=s.legacyOriginal,b={...s.booking,id:"ext_"+e.id,from:900,to:960};
    const approval={schema:1,approved:true,eventId:e.id,etag:e.etag,description:e.description,booking:b};
    let injected=false;
    const lostResponse=(method,...args)=>{
      const r=crmGasCalendarRequest_(method,...args);
      if(method==="PATCH"&&r.code===200&&!injected){injected=true;throw Error("SYNTHETIC_LOST_PATCH_RESPONSE");}return r;
    };
    try{crmAdoptCalendarEvent_(lostResponse,env.calendarId,e,env.profiles,env.tariff,approval);}
    catch(error){if(error.message!=="SYNTHETIC_LOST_PATCH_RESPONSE")throw error;}
    crmAdoptCalendarEvent_(crmGasCalendarRequest_,env.calendarId,e,env.profiles,env.tariff,approval);
    s.lostResponseInjected=injected||s.lostResponseInjected===true;
    s.legacyIntent=crmAcceptanceSync_(env,"adopt_"+s.booking.id,null,null,b);
    if(!crmAdoptCalendarEvent_(crmGasCalendarRequest_,env.calendarId,e,env.profiles,env.tariff,approval).replayed)throw Error("Legacy replay failed");
    const row=crmSheetRows_(env.sheets["Аренды"],"Аренды").find(r=>r.values[11]===b.id);
    const projected=crmFinancialRow_(row,b,1,env.profiles,env.tariff,env.payments.list());
    if(projected[6]!==""||projected[8]!=="")throw Error("Imported price invented");
    s.legacyBooking=b;s.phase=3;crmAcceptanceSave_(env,s);
    console.log(JSON.stringify({legacyAdoption:"PASS",sameCalendarId:true,replay:"PASS",priceBlank:true}));
  }finally{lock.releaseLock();}
}
function crmAcceptanceCancelTest(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw Error("Busy");
  try{
    const env=crmAcceptanceEnv_(),s=crmAcceptanceState_(env);if(s.phase!==3)throw Error("Legacy phase required");
    for(const b of [s.moved,s.legacyBooking]){
      const current=env.port.read("calendar",b.id);
      if(current!==null){if(!crmSyncEqual_(current,b))throw Error("Synthetic event changed");env.port.compareAndWrite("calendar",b.id,b,null);}
      crmAcceptanceSync_(env,"cancel_"+b.id,b,b,null);
      if(env.port.read("sheet",b.id)?.status!=="cancelled"||env.accepted.read(b.id)?.status!=="cancelled")throw Error("Cancellation not synchronized");
    }
    s.phase=4;crmAcceptanceSave_(env,s);console.log(JSON.stringify({calendarCancellationToSheet:"PASS",fixturesCancelled:2}));
  }finally{lock.releaseLock();}
}
function crmAcceptanceVerifyTest(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(5000))throw Error("Busy");
  try{
    const env=crmAcceptanceEnv_(),s=crmAcceptanceState_(env);if(s.phase!==4)throw Error("Cancellation phase required");
    const count=env.journal.list().length;
    for(let i=0;i<2;i++)for(const b of [s.moved,s.legacyBooking])crmAcceptanceSync_(env,"cancel_"+b.id,b,b,null);
    if(env.journal.list().length!==count)throw Error("Replay duplicated operations");
    if(crmAcceptanceHash_(env,[crmRuntimeEventId_(s.booking.id),s.legacyEventId])!==s.originalHash)throw Error("Original Calendar changed");
    if(crmBackupDigest_(crmMigrationCanonical_(env.payments.list()))!==s.ledgerHash)throw Error("Payment ledger changed");
    for(const row of crmSheetRows_(env.sheets["Аренды"],"Аренды").filter(r=>[s.booking.id,s.legacyBooking.id].includes(r.values[11])))if([6,7,8].some(i=>row.values[i]!==""))throw Error("Unexpected fixture financial entry");
    if(!s.lostResponseInjected)throw Error("Lost-response scenario was not exercised");
    const report={status:"PASS",create:true,calendarMove:true,overlapRejected:true,legacyIdPreserved:true,legacyReplay:true,lostPatchResponseRecovered:true,cancelledFixtures:2,noOpReplays:2,originalCalendarUnchanged:true,paymentsUnchanged:true,endedAt:new Date().toISOString()};
    env.props.setProperty("CRM_V2_LIVE_ACCEPTANCE_REPORT",JSON.stringify(report));env.props.setProperty("CRM_V2_TEST_WRITE_ENABLED","false");env.props.setProperty("CRM_V2_LIVE_ACCEPTANCE_ENABLED","false");
    console.log(JSON.stringify(report));return report;
  }finally{lock.releaseLock();}
}
