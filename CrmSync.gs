// Isolated CRM v2 operation coordinator. No deployed service wiring.
// Requires CrmCore.gs and CrmRegistry.gs. Port methods are synchronous.
function crmSyncEqual_(a,b) {
  if(a===null||b===null)return a===b;
  return JSON.stringify(crmBookingSnapshot_(a))===JSON.stringify(crmBookingSnapshot_(b));
}

function crmSyncIntent_(input) {
  // Null means positively verified absence; a failed/incomplete read must throw upstream.
  const {id,base,sheet,calendar,calendarDeleted}=input;
  crmId_(id);
  if(typeof calendarDeleted!=="boolean")throw Error("Missing deletion evidence flag");
  for(const b of [base,sheet,calendar])if(b!==null)crmValidateBooking_(b);
  if([base,sheet,calendar].filter(Boolean).some(b=>b.id!==(base||sheet||calendar).id))throw Error("Identity mismatch");
  if(calendarDeleted!==(base!==null&&calendar===null&&base.status!=="cancelled"))throw Error("Inconsistent deletion evidence");
  if(!base&&!sheet&&!calendar)throw Error("No booking");
  if(base&&!sheet)return {kind:"conflict",fields:["missing_sheet_row"]};
  let desired,priceReview;
  if(!base){
    if(sheet&&calendar&&!crmSyncEqual_(sheet,calendar))return {kind:"conflict",fields:["new_identity_collision"]};
    desired=crmBookingSnapshot_(sheet||calendar);
    if(desired.status==="cancelled")return {kind:"conflict",fields:["new_cancelled_record"]};
    priceReview=desired.status==="confirmed";
  }else{
    const normalized=calendar||{...base,status:"cancelled"};
    const merge=crmMergeBooking_(base,sheet,normalized);
    if(merge.kind==="conflict")return merge;
    desired=merge.booking;priceReview=merge.priceReview;
  }
  const intent={id,base:base&&crmBookingSnapshot_(base),sheet:sheet&&crmBookingSnapshot_(sheet),calendar:calendar&&crmBookingSnapshot_(calendar),desired,priceReview,calendarDeleted};
  return {kind:"intent",intent};
}

function crmSyncDesired_(intent,target) {
  if(target==="sheet"||target==="accepted")return intent.desired;
  if(target==="calendar")return intent.desired.status==="cancelled"?null:intent.desired;
  throw Error("Unknown sync target");
}

function crmValidateSyncIntent_(intent) {
  if(!intent||typeof intent!=="object")throw Error("Missing sync intent");
  const result=crmSyncIntent_(intent);
  if(result.kind!=="intent"||JSON.stringify(result.intent)!==JSON.stringify(intent))throw Error("Invalid or noncanonical sync intent");
  return intent;
}

function crmRunSync_(port,intent) {
  // Port contract: a shared lock around this entire call; read() throws on uncertain
  // state, compareAndWrite() rechecks expected state and uses Calendar ETag.
  // Journal save must be durable before any target write. Accepted state is committed last.
  crmValidateSyncIntent_(intent);
  const saved=port.load(intent.id);
  if(saved){
    if(JSON.stringify(saved.intent)!==JSON.stringify(intent))throw Error("Operation ID reused");
    if(saved.status==="done"||saved.status==="conflict")return saved;
    if(saved.status!=="pending")throw Error("Invalid journal state");
  }else{
    if(port.hasPending(intent.desired.id))throw Error("Booking already has unresolved operation");
    port.save({intent,status:"pending"});
  }
  const conflict=(reason)=>{
    const record={intent,status:"conflict",reason};port.save(record);return record;
  };
  // Inspect all targets before writes: an unexpected manual edit stops the operation.
  const expected={sheet:intent.sheet,calendar:intent.calendar,accepted:intent.base};
  const targets=["sheet","calendar","accepted"];
  const current={};
  for(const target of targets){
    current[target]=port.read(target,intent.desired.id);
    const desired=crmSyncDesired_(intent,target);
    if(!crmSyncEqual_(current[target],expected[target])&&!crmSyncEqual_(current[target],desired))return conflict("changed_"+target);
  }
  if(!port.isAvailable(intent.desired))return conflict("overlap");
  // The adapter must compare-and-write atomically where supported; a transient
  // exception leaves pending and retry reads actual state before reissuing a write.
  for(const target of targets){
    const desired=crmSyncDesired_(intent,target);
    if(!crmSyncEqual_(current[target],desired)){
      port.compareAndWrite(target,intent.desired.id,current[target],desired);
      if(!crmSyncEqual_(port.read(target,intent.desired.id),desired))throw Error("Write not verified: "+target);
    }
  }
  for(const target of targets)if(!crmSyncEqual_(port.read(target,intent.desired.id),crmSyncDesired_(intent,target)))return conflict("changed_after_write_"+target);
  const done={intent,status:"done"};port.save(done);return done;
}
