// Add as a separate file ONLY to the known legacy TEST project.
// No secrets or customer records are returned. No automatic invocation.
function legacyTestAudit(){
  const cfg=config_(),props=PropertiesService.getScriptProperties();
  if(cfg.spreadsheetId!==BD.testSpreadsheet||cfg.calendarId!==BD.testCalendar)throw Error("Not the exact legacy TEST binding");
  const book=SpreadsheetApp.openById(cfg.spreadsheetId),cal=Calendar.CalendarList.get(cfg.calendarId);
  if(!/^ТЕСТ — /.test(book.getName())||book.getSpreadsheetTimeZone()!=="Europe/Moscow"||
    cal.accessRole!=="owner"||cal.primary||cal.timeZone!=="Europe/Moscow"||cal.summary!=="ТЕСТ — Студия (GAS ↔ таблица)")throw Error("TEST isolation not verified");
  if(props.getProperty("BD_TARGET_BINDING")!==cfg.spreadsheetId+"|"+cfg.calendarId)throw Error("Legacy checkpoint binding missing or different");
  if(props.getProperty("BIDIR_PRODUCTION_APPROVED"))throw Error("Production approval present; manual review required");
  const keys=props.getKeys(),pending=keys.filter(k=>k.startsWith("BD_PENDING_")).length;
  const triggers=ScriptApp.getProjectTriggers().map(t=>({handler:t.getHandlerFunction(),source:String(t.getTriggerSource()),event:String(t.getEventType()),sourceId:t.getTriggerSourceId(),id:t.getUniqueId()}));
  for(const t of triggers){
    if(!["bdOnSheetEdit","bdOnCalendarChange","bdTimer","syncCalendarToSheet","pollTelegram"].includes(t.handler))throw Error("Unknown legacy handler");
    if(t.handler==="bdOnSheetEdit"&&t.sourceId!==cfg.spreadsheetId)throw Error("Sheet trigger binding differs");
    if(t.handler==="bdOnCalendarChange"&&t.sourceId!==cfg.calendarId)throw Error("Calendar trigger binding differs");
  }
  const result={mode:"TEST",exactBinding:true,checkpointBinding:true,pending,paused:props.getProperty("BIDIR_PAUSED")==="true",
    writeEnabled:cfg.writeEnabled,handlers:triggers.map(t=>t.handler)};
  console.log(JSON.stringify(result));return {result,triggers,spreadsheetId:cfg.spreadsheetId,calendarId:cfg.calendarId};
}
function legacyStopTestBookingWriters(){
  const lock=LockService.getScriptLock();if(!lock.tryLock(20000))throw Error("Legacy execution still active");
  try{
    const audit=legacyTestAudit();if(audit.result.pending)throw Error("Recover pending legacy days before stopping");
    const props=PropertiesService.getScriptProperties();
    if(!props.getProperty("LEGACY_TEST_TRIGGER_ARCHIVE"))props.setProperty("LEGACY_TEST_TRIGGER_ARCHIVE",JSON.stringify({schema:1,at:new Date().toISOString(),...audit}));
    // Pause is durable before trigger removal; all bd reconciliation paths check it.
    props.setProperty("BIDIR_PAUSED","true");
    for(const trigger of ScriptApp.getProjectTriggers())if(["bdOnSheetEdit","bdOnCalendarChange","bdTimer","syncCalendarToSheet"].includes(trigger.getHandlerFunction()))ScriptApp.deleteTrigger(trigger);
    const remaining=ScriptApp.getProjectTriggers().map(t=>t.getHandlerFunction());
    if(remaining.some(x=>x!=="pollTelegram"))throw Error("Booking writer still present");
    const result={mode:"TEST",stopped:true,at:new Date().toISOString(),scriptId:ScriptApp.getScriptId(),calendarId:audit.calendarId,legacySpreadsheetId:audit.spreadsheetId,remaining};
    props.setProperty("LEGACY_TEST_HANDOVER",JSON.stringify(result));
    // Private handover export deliberately omits tokens and full property values.
    console.log(JSON.stringify({mode:"TEST",stopped:true,remaining}));return result;
  }finally{lock.releaseLock();}
}
