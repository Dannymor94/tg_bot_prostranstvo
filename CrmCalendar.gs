// Google Calendar REST adapter for managed CRM events, not wired to triggers.
// Request transport returns {code,body}; caller verifies TEST binding and holds lock.
function crmCalendarEventId_(id){
  crmId_(id);return "crm2"+Array.from(id,c=>c.charCodeAt(0).toString(16).padStart(2,"0")).join("");
}
function crmCalendarTime_(date,minute){
  crmCivilDate_(date);
  if(date<"2015-01-01"||!Number.isInteger(minute)||minute<0||minute>=1440)throw Error("Unsupported Moscow interval");
  return date+"T"+String(Math.floor(minute/60)).padStart(2,"0")+":"+String(minute%60).padStart(2,"0")+":00+03:00";
}
function crmCalendarLocal_(raw){
  if(typeof raw!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw))throw Error("Invalid Calendar time");
  const ms=Date.parse(raw);
  if(!Number.isFinite(ms)||ms%60000!==0)throw Error("Unsupported Calendar seconds");
  const local=new Date(ms+10800000).toISOString();
  const date=local.slice(0,10);crmCivilDate_(date);
  if(date<"2015-01-01")throw Error("Unsupported Moscow date");
  return {date,minute:Number(local.slice(11,13))*60+Number(local.slice(14,16))};
}
function crmCalendarBody_(b,tenantName){
  crmValidateBooking_(b);
  if(b.status==="cancelled"||typeof tenantName!=="string")throw Error("Invalid Calendar projection");
  return {summary:[tenantName,b.direction].filter(Boolean).join(" — ")||"Аренда (уточнить)",
    description:"CRM v2\n"+JSON.stringify({tenantId:b.tenantId,direction:b.direction,format:b.format,status:b.status}),
    start:{dateTime:crmCalendarTime_(b.date,b.from),timeZone:"Europe/Moscow"},
    end:{dateTime:crmCalendarTime_(b.date,b.to),timeZone:"Europe/Moscow"},
    visibility:"private",transparency:"opaque",
    extendedProperties:{private:{crmBookingId:b.id}}};
}
function crmCalendarSnapshot_(event,id,expectedEventId){
  crmId_(id);
  if(!event||event.id!==expectedEventId||event.extendedProperties?.private?.crmBookingId!==id||event.recurringEventId||event.recurrence?.length||event.attendees?.length||event.eventType&&event.eventType!=="default")throw Error("Unmanaged or unsupported Calendar event");
  if(event.status!=="confirmed"&&event.status!=="tentative")throw Error("Unsupported Calendar status");
  if(typeof event.etag!=="string"||!event.etag)throw Error("Missing Calendar ETag");
  if(typeof event.description!=="string"||!event.description.startsWith("CRM v2\n"))throw Error("Unrecognized Calendar description");
  const fields=JSON.parse(event.description.slice(7));
  const start=crmCalendarLocal_(event.start?.dateTime),end=crmCalendarLocal_(event.end?.dateTime);
  if(start.date!==end.date)throw Error("Multi-day booking requires review");
  const booking=crmBookingSnapshot_({id,date:start.date,from:start.minute,to:end.minute,tenantId:fields.tenantId,direction:fields.direction,format:fields.format,status:fields.status});
  if(booking.status==="cancelled"||event.transparency==="transparent"||event.visibility!=="private")throw Error("Invalid Calendar projection");
  return booking;
}
function crmCalendarPort_(request,calendarId,tenantName,eventIdFor){
  if(typeof request!=="function"||typeof calendarId!=="string"||!calendarId||calendarId==="primary"||typeof tenantName!=="function")throw Error("Invalid Calendar binding");
  const prefix="/calendars/"+encodeURIComponent(calendarId),events=prefix+"/events";
  function eventId(id){const value=eventIdFor?eventIdFor(id):crmCalendarEventId_(id);if(typeof value!=="string"||!value||value.length>1024)throw Error("Invalid Calendar event ID");return value;}
  function verifiedCalendar(){
    const r=request("GET",prefix,null,{});
    if(r.code!==200||r.body?.id!==calendarId||r.body?.timeZone!=="Europe/Moscow")throw Error("Calendar binding/access check failed");
  }
  function fetch(id){
    const eid=eventId(id),r=request("GET",events+"/"+encodeURIComponent(eid),null,{});
    if(r.code===404||r.code===410){verifiedCalendar();return {booking:null,event:null};}
    if(r.code!==200)throw Error("Calendar read failed: "+r.code);
    if(r.body?.id===eid&&r.body.status==="cancelled"){verifiedCalendar();return {booking:null,event:null};}
    return {booking:crmCalendarSnapshot_(r.body,id,eid),event:r.body};
  }
  function read(id){return fetch(id).booking;}
  function compareAndWrite(id,before,desired){
    crmId_(id);
    if(desired!==null&&desired.id!==id)throw Error("Calendar booking ID mismatch");
    const current=fetch(id),eid=eventId(id);
    if(!crmSyncEqual_(current.booking,before))throw Error("Calendar compare mismatch");
    if(crmSyncEqual_(current.booking,desired))return;
    let r;
    if(desired===null){
      r=request("DELETE",events+"/"+encodeURIComponent(eid),null,{"If-Match":current.event.etag});
      if(r.code!==204&&r.code!==404&&r.code!==410)throw Error("Calendar delete failed: "+r.code);
    }else{
      const body=crmCalendarBody_(desired,desired.tenantId===null?"":tenantName(desired.tenantId));
      if(current.event){
        // Preserve unrelated event metadata/private properties; ETag blocks newer UI edits.
        body.extendedProperties.private={...current.event.extendedProperties.private,crmBookingId:id};
        r=request("PATCH",events+"/"+encodeURIComponent(eid),body,{"If-Match":current.event.etag});
        if(r.code!==200)throw Error("Calendar patch failed: "+r.code);
      }else{
        r=request("POST",events,{...body,id:eid},{});
        if(r.code!==200&&r.code!==201&&r.code!==409)throw Error("Calendar insert failed: "+r.code);
      }
    }
    if(!crmSyncEqual_(read(id),desired))throw Error("Calendar write not verified");
  }
  return {read,compareAndWrite};
}
function crmCalendarChanges_(request,calendarId,syncToken){
  if(typeof calendarId!=="string"||!calendarId||calendarId==="primary"||(syncToken!==null&&(typeof syncToken!=="string"||!syncToken)))throw Error("Invalid Calendar list parameters");
  const prefix="/calendars/"+encodeURIComponent(calendarId)+"/events";
  function collect(token){
    const items=[],seen=new Set(),ids=new Set();let page=null;
    for(let i=0;i<100;i++){
      const query=["showDeleted=true","singleEvents=false","maxResults=250"];
      if(token)query.push("syncToken="+encodeURIComponent(token));
      if(page)query.push("pageToken="+encodeURIComponent(page));
      const r=request("GET",prefix+"?"+query.join("&"),null,{});
      if(r.code===410&&token)return null;
      if(r.code!==200||!Array.isArray(r.body?.items))throw Error("Calendar list incomplete: "+r.code);
      for(const e of r.body.items){
        if(!e||typeof e.id!=="string"||!e.id||ids.has(e.id))throw Error("Invalid or duplicate listed event");
        ids.add(e.id);items.push(e);
      }
      page=r.body.nextPageToken;
      if(page){
        if(typeof page!=="string"||seen.has(page)||r.body.nextSyncToken)throw Error("Invalid Calendar pagination");
        seen.add(page);continue;
      }
      if(typeof r.body.nextSyncToken!=="string"||!r.body.nextSyncToken)throw Error("Missing final sync token");
      return {items,nextSyncToken:r.body.nextSyncToken,full:token===null};
    }
    throw Error("Calendar page limit exceeded");
  }
  // Never publish token here; caller commits only after durable handling of all items.
  return collect(syncToken)||collect(null);
}
function crmGasCalendarRequest_(method,path,body,headers){
  if(!/^\/calendars\//.test(path))throw Error("Invalid Calendar API path");
  const options={method:method.toLowerCase(),headers:{...headers,Authorization:"Bearer "+ScriptApp.getOAuthToken()},muteHttpExceptions:true,followRedirects:false};
  if(body!==null){options.contentType="application/json";options.payload=JSON.stringify(body);}
  const response=UrlFetchApp.fetch("https://www.googleapis.com/calendar/v3"+path,options);
  const code=response.getResponseCode(),raw=response.getContentText();
  let parsed=null;if(raw){try{parsed=JSON.parse(raw);}catch(e){throw Error("Calendar response is not JSON: "+code);}}
  return {code,body:parsed};
}
