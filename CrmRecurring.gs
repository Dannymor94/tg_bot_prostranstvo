// Weekly rules in tenant column F. TEST only; one interval per weekday per tenant.
// Entering an explicit rule and enabling the TEST recurrence flag authorizes
// creation of future occurrences, never edits to existing reservations.
function crmRecurringRules_(raw,cfg){
  crmValidateTariff_(cfg);
  if(typeof raw!=="string")throw Error("Invalid weekly schedule");
  if(!raw.trim())return [];
  if(raw.length>500)throw Error("Weekly schedule too long");
  const days={вс:0,пн:1,вт:2,ср:3,чт:4,пт:5,сб:6},rules=[],seen=new Set();
  for(const part of raw.trim().split(/[;\n]+/)){
    const m=/^(вс|пн|вт|ср|чт|пт|сб)\s+(\d{2}:\d{2})\s*[-–—]\s*(\d{2}:\d{2})$/iu.exec(part.trim());
    if(!m)throw Error("Use Пн 18:30-20:00; Ср 18:30-20:00");
    const weekday=days[m[1].toLowerCase()],from=crmSheetMinute_(m[2]),to=crmSheetMinute_(m[3]);
    const [open,close]=crmPeriod_("all",cfg);
    if(seen.has(weekday)||from<open||to>close||to<=from)throw Error("Invalid or duplicate weekly interval");
    seen.add(weekday);rules.push({weekday,from,to});
  }
  return rules.sort((a,b)=>a.weekday-b.weekday);
}
function crmRecurringId_(tenantId,date){
  crmId_(tenantId);crmCivilDate_(date);
  // Stable per tenant/day, not time or tariff; rule edits do not recreate a
  // moved or cancelled occurrence. Long custom tenant IDs fail closed.
  return crmId_("rec_"+tenantId+"_"+date);
}
function crmRecurringInputs_(tenantSheet,profiles,cfg){
  const byId=new Map(profiles.map(p=>[p.id,p])),inputs=[],errors=[];
  for(const r of crmSheetRows_(tenantSheet,"Арендаторы")){
    const raw=r.values[5],id=r.values[7];
    if(raw==="")continue;
    try{
      if(r.formulas.some(Boolean)||!byId.has(id))throw Error("Missing managed tenant");
      const p=byId.get(id);
      if(!p.format||!p.direction.trim())throw Error("Missing tenant defaults");
      const rules=crmRecurringRules_(raw,cfg);
      inputs.push({profile:p,rules});
    }catch(e){errors.push({row:r.row,reason:"invalid_weekly_rule"});}
  }
  return {inputs,errors};
}
function crmRecurringCandidates_(inputs,today,days,cfg){
  crmCivilDate_(today);
  if(!Array.isArray(inputs)||!Number.isInteger(days)||days<1||days>120)throw Error("Invalid recurrence horizon");
  const out=[],seen=new Set();
  for(const {profile:p,rules} of inputs){
    for(let offset=1;offset<=days;offset++){
      const date=crmTgAddDays_(today,offset),weekday=crmCivilDate_(date).getUTCDay();
      for(const r of rules.filter(x=>x.weekday===weekday)){
        const id=crmRecurringId_(p.id,date);
        if(seen.has(id))throw Error("Duplicate recurrence candidate");
        seen.add(id);
        const b=crmBookingSnapshot_({id,date,from:r.from,to:r.to,tenantId:p.id,direction:p.direction,format:p.format,status:"confirmed"});
        const quote=crmQuote_({...b,regular:p.regular,internal:p.internal},cfg);
        out.push({booking:b,quote});
      }
    }
  }
  return out.sort((a,b)=>a.booking.date.localeCompare(b.booking.date)||a.booking.from-b.booking.from||a.booking.id.localeCompare(b.booking.id));
}
function crmRecurringPass_(port,candidates,limit){
  if(!Array.isArray(candidates)||!Number.isInteger(limit)||limit<1||limit>100)throw Error("Invalid recurrence pass");
  const inventory=port.inventory();
  if(!Array.isArray(inventory.ids)||!Array.isArray(inventory.unmanaged))throw Error("Incomplete recurrence inventory");
  const snapshots=[],knownIds=new Set(inventory.ids);
  for(const id of knownIds){
    crmId_(id);
    for(const target of ["sheet","accepted"]){
      const b=port.read(target,id);
      if(b)snapshots.push(crmBookingSnapshot_(b));
    }
  }
  // History includes earlier intervals of moved/cancelled manual bookings.
  // A matched original occurrence is never silently resurrected.
  const records=port.list();
  if(!Array.isArray(records))throw Error("Missing recurrence history");
  for(const raw of records){
    const r=crmJournalRecord_(raw);
    for(const b of [r.intent.base,r.intent.sheet,r.intent.calendar,r.intent.desired])if(b){
      knownIds.add(b.id);snapshots.push(b);
    }
  }
  const report={created:0,existing:0,review:[],errors:[],limited:false};
  let writes=0;
  for(const {booking:b,quote:q} of candidates){
    crmValidateBooking_(b);
    if(knownIds.has(b.id)){report.existing++;continue;}
    const sameDay=snapshots.filter(x=>x.tenantId===b.tenantId&&x.date===b.date);
    if(sameDay.some(x=>x.from===b.from&&x.to===b.to)){report.existing++;continue;}
    if(sameDay.length){report.review.push({id:b.id,date:b.date,reason:"existing_tenant_day"});continue;}
    try{
      // Guard against an existing event not present in the original snapshot.
      if(["sheet","accepted","calendar"].some(t=>port.read(t,b.id)!==null)||port.hasPending(b.id)){report.existing++;continue;}
      if(!port.isAvailable(b)){report.review.push({id:b.id,date:b.date,reason:"occupied"});continue;}
      if(writes>=limit){report.limited=true;break;}
      writes++;
      // Same atomic row write as confirmed Telegram creation. Stable ID and
      // persisted quote survive a lost response; existing reconciliation
      // handles staged rows. Never create a second direct Calendar writer.
      port.compareAndWrite("sheet",b.id,null,b,{totalKopecks:q.totalKopecks,tariffVersion:q.tariffVersion});
      knownIds.add(b.id);snapshots.push(b);report.created++;
    }catch(e){
      report.errors.push({id:b.id,date:b.date,reason:"recurrence_write_or_read_failed"});
      // A write may have succeeded. Stop until a fresh inventory is read.
      break;
    }
  }
  return report;
}
