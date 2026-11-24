// Manual TEST entry points. Never install v2 triggers while the v1 writer is active.
// Script Properties must be configured in a separate Apps Script project; no IDs in code.
function crmV2BoundTest_(){
  const props=PropertiesService.getScriptProperties();
  const binding=JSON.parse(props.getProperty("CRM_V2_BINDING")||"null");
  if(!binding||binding.mode!=="TEST"||typeof binding.spreadsheetId!=="string"||!binding.spreadsheetId||
     typeof binding.calendarId!=="string"||!binding.calendarId||binding.calendarId==="primary")throw Error("CRM v2 TEST binding missing");
  if(props.getProperty("BIDIR_ACTIVE")||props.getProperty("BD_TARGET_BINDING"))throw Error("Legacy binding present: use a separate GAS project");
  if(ScriptApp.getProjectTriggers().some(t=>["bdOnSheetEdit","bdOnCalendarChange","bdTimer","pollTelegram"].includes(t.getHandlerFunction())))throw Error("Legacy triggers present");
  const book=SpreadsheetApp.openById(binding.spreadsheetId);
  if(book.getId()!==binding.spreadsheetId||!/^ТЕСТ — Пространство йоги — Mini CRM v2/.test(book.getName())||
     book.getSpreadsheetTimeZone()!=="Europe/Moscow")throw Error("Wrong CRM TEST spreadsheet");
  const cal=Calendar.CalendarList.get(binding.calendarId);
  if(!cal||cal.id!==binding.calendarId||cal.accessRole!=="owner"||cal.timeZone!=="Europe/Moscow"||
     !/^ТЕСТ — .*CRM v2/.test(cal.summary||""))throw Error("Wrong or non-owned TEST calendar");
  const sheets={};
  for(const name of ["Аренды","Арендаторы","Настройки","Оплаты","_CRM_JOURNAL","_CRM_ACCEPTED"]){
    const sheet=book.getSheetByName(name);
    if(!sheet)throw Error("Missing required CRM sheet");
    sheets[name]=sheet;
  }
  const tariff=crmReadSettings_(sheets["Настройки"]);
  const profiles=crmTenantProfiles_(sheets["Арендаторы"]);
  const flush=()=>SpreadsheetApp.flush();
  const sheet=crmSheetBookingPort_(sheets["Аренды"],sheets["Арендаторы"],flush);
  const accepted=crmAcceptedPort_(sheets["_CRM_ACCEPTED"],flush);
  const journal=crmJournalForSheet_(sheets["_CRM_JOURNAL"],flush);
  const payments=crmPaymentPort_(sheets["Оплаты"],flush);
  const name=id=>{
    const p=crmTenantProfiles_(sheets["Арендаторы"]).find(x=>x.id===id);
    if(!p)throw Error("Unknown tenant");return p.name;
  };
  const port=crmRuntimePort_(sheet,accepted,journal,crmGasCalendarRequest_,binding.calendarId,name,()=>Utilities.getUuid());
  return {props,tariff,profiles,payments,port};
}
function crmV2Preflight(){
  // Read-only: no changes, no trigger creation.
  const env=crmV2BoundTest_(),inventory=env.port.inventory(),records=env.port.list();
  const report={mode:"TEST",managed:inventory.ids.length,unmanaged:inventory.unmanaged.length,tenants:env.profiles.length,
    payments:env.payments.list().length,pending:records.filter(r=>r.status==="pending").length,conflicts:records.filter(r=>r.status==="conflict").length,
    writeEnabled:env.props.getProperty("CRM_V2_TEST_WRITE_ENABLED")==="true"};
  console.log(JSON.stringify(report));return report;
}
function crmV2ReconcileTest(){
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(5000))return {ok:false,reason:"busy"};
  try{
    const env=crmV2BoundTest_();
    if(env.props.getProperty("CRM_V2_TEST_WRITE_ENABLED")!=="true")throw Error("CRM v2 test writes disabled");
    // Deliberately manual invocation until intake, financial projection and protections are ready.
    const report=crmRuntimePass_(env.port,10,env.props.getProperty("CRM_V2_SCAN_AFTER")||null);
    if(report.nextAfterId!==null)env.props.setProperty("CRM_V2_SCAN_AFTER",report.nextAfterId);
    env.props.setProperty("CRM_V2_LAST_REPORT",JSON.stringify({at:new Date().toISOString(),ok:report.ok,completed:report.completed,
      pending:report.pending,unmanaged:report.unmanaged,conflicts:report.conflicts.length,errors:report.errors.length,limited:report.limited}));
    console.log(JSON.stringify({ok:report.ok,completed:report.completed,pending:report.pending,unmanaged:report.unmanaged,conflicts:report.conflicts.length,errors:report.errors.length}));
    return report;
  }finally{lock.releaseLock();}
}
