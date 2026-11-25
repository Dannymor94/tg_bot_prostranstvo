// Telegram v2 query grammar; civil date/time in Moscow supplied by caller.
// No LLM, no mutation, no guessing when requests contain contradictory terms.
function crmTgAddDays_(date,n){
  const d=crmCivilDate_(date);d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);
}
function crmTgParseQuery_(raw,today,now,cfg){
  crmCivilDate_(today);crmValidateTariff_(cfg);
  if(!Number.isInteger(now)||now<0||now>=1440)throw Error("Invalid clock");
  if(typeof raw!=="string"||raw.length>300)return {error:"Укажи один день и время."};
  let s=raw.toLowerCase().replace(/ё/g,"е").replace(/[–—]/g,"-").trim();
  const error=message=>({error:message});
  const take=re=>{const matches=[...s.matchAll(re)];s=s.replace(re," ");return matches;};
  const times=take(/(?<![\d.])(?:с\s*|от\s*)?(\d{1,2})(?::(\d{2}))?\s*(?:до|по|-)\s*(\d{1,2})(?::(\d{2}))?(?![\d.:])/gu);
  if(times.length>1)return error("Укажи один интервал.");
  let from=null,to=null;
  if(times.length){
    const [,h,m,j,k]=times[0];from=Number(h)*60+Number(m||0);to=Number(j)*60+Number(k||0);
    if(+h>23||+j>23||+(m||0)>59||+(k||0)>59||to<=from)return error("Проверь время начала и окончания.");
  }
  const dates=take(/(?<![\d.])(\d{1,2})[./](\d{1,2})(?:[./](\d{4}))?(?![\d.])/gu);
  const months=["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  const named=take(/(?<!\d)(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+(\d{4}))?(?![\p{L}\d])/gu);
  const relative=take(/(?<!\p{L})(послезавтра|завтра|сегодня)(?!\p{L})/gu);
  const weekdays=[["вс","воскресенье","воскресенья"],["пн","понедельник","понедельника"],["вт","вторник","вторника"],["ср","среда","среду","среды"],["чт","четверг","четверга"],["пт","пятница","пятницу","пятницы"],["сб","суббота","субботу","субботы"]];
  const dayWords=take(new RegExp("(?<!\\p{L})("+weekdays.flat().join("|")+")(?!\\p{L})","gu"));
  const parts=take(/(?<!\p{L})(утром|утро|днем|день|вечером|вечер)(?!\p{L})/gu);
  const part=parts.length?({утром:"morning",утро:"morning",днем:"day",день:"day",вечером:"evening",вечер:"evening"})[parts[0][1]]:"all";
  const next=take(/(?<!\p{L})(?:на\s+следующей\s+неделе|следующ(?:ий|ая|ую|ее)|будущ(?:ий|ая|ую|ее))(?!\p{L})/gu);
  const nearest=take(/(?<!\p{L})ближайш(?:ий|ая|ую|ее)(?!\p{L})/gu);
  const durations=take(/(?<![\d.,])(?:на\s+)?(\d{1,3}(?:[.,]\d{1,2})?)\s*(часа|часов|час|ч|минуты|минут|минута|мин)(?!\p{L})/gu);
  const bareHour=take(/(?<!\p{L})на\s+час(?!\p{L})/gu);
  let duration=bareHour.length?60:0;
  if(durations.length){
    const m=durations[0];duration=Number(m[1].replace(",","."))*(m[2].startsWith("мин")?1:60);
    if(!Number.isInteger(duration)||duration<1||duration>1440)return error("Укажи длительность в часах или минутах.");
  }
  if(dates.length+named.length+relative.length>1||dayWords.length>1||parts.length>1||next.length+nearest.length>1||durations.length+bareHour.length>1||times.length&&(durations.length||bareHour.length))return error("Укажи одну дату, период и длительность.");
  const formatWords=take(/(?<!\p{L})(индивидуальн(?:ое|ый|ая|о)|группов(?:ое|ой|ая|ые)|группа)(?!\p{L})/gu);
  if(formatWords.length>1)return error("Укажи один формат занятия.");
  const format=formatWords.length?(formatWords[0][1].startsWith("индивидуаль")?"individual":"group"):null;
  const price=take(/(?<!\p{L})(?:сколько\s+стоит|стоимость|цена)(?!\p{L})/gu).length>0;
  s=s.replace(/\/free(?:@\w+)?/g," ").replace(/(?<!\p{L})(?:есть\s+ли|свободн(?:о|ое|ые|ый)|свободных|окна|окно|время|аренда|аренды|можно|пожалуйста|студия|студию|в|на|за)(?!\p{L})/gu," ").replace(/[?!,;\s]+/g," ").trim();
  if(s)return error("Не удалось однозначно разобрать запрос. Например: «завтра утром на 2 часа».");
  const weekday=dayWords.length?weekdays.findIndex(a=>a.includes(dayWords[0][1])):-1;
  if((next.length||nearest.length)&&(weekday<0||dates.length||named.length||relative.length))return error("Уточни день недели.");
  let date=null;
  if(relative.length)date=crmTgAddDays_(today,{сегодня:0,завтра:1,послезавтра:2}[relative[0][1]]);
  if(dates.length||named.length){
    const m=dates[0]||named[0],month=dates.length?Number(m[2]):months.indexOf(m[2])+1;
    const year=m[3]?Number(m[3]):Number(today.slice(0,4));
    const key=y=>String(y)+"-"+String(month).padStart(2,"0")+"-"+String(+m[1]).padStart(2,"0");
    date=key(year);
    try{crmCivilDate_(date);if(!m[3]&&date<today){date=key(year+1);crmCivilDate_(date);}}catch(e){return error("Некорректная дата.");}
  }
  if(date&&weekday>=0&&crmCivilDate_(date).getUTCDay()!==weekday)return error("Дата не совпадает с днем недели.");
  if(!date&&weekday>=0){
    if(next.length){const dow=crmCivilDate_(today).getUTCDay();date=crmTgAddDays_(today,7-(dow+6)%7+(weekday+6)%7);}
    else{date=crmNearestWeekday_(today,now,weekday,part,cfg);if(date===today&&from!==null&&from<now)date=crmTgAddDays_(today,7);}
  }
  if(!date)return error("Укажи дату или день недели.");
  if(date<today||date>=crmTgAddDays_(today,120))return error("Выбери дату в ближайшие 120 дней.");
  const [a,b]=crmPeriod_(part,cfg);
  if(from!==null&&(from<a||to>b||date===today&&from<now))return error("Время уже прошло или выходит за выбранный период.");
  if(duration>b-a)return error("Длительность не помещается в выбранный период.");
  return {date,part,from,to,duration,format,price};
}
function crmTgFreeFromBusy_(cfg,date,intervals){
  crmCivilDate_(date);const [open,close]=crmPeriod_("all",cfg);
  if(!Array.isArray(intervals))throw Error("Incomplete busy inventory");
  const busy=intervals.map(w=>{
    if(!Array.isArray(w)||w.length!==2||!w.every(Number.isInteger)||w[0]<0||w[1]>1440||w[0]>=w[1])throw Error("Invalid busy interval");
    return [Math.max(open,w[0]),Math.min(close,w[1])];
  }).filter(w=>w[0]<w[1]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let pos=open;const free=[];
  for(const [a,b] of busy){if(a>pos)free.push([pos,a]);pos=Math.max(pos,b);}
  if(pos<close)free.push([pos,close]);return free;
}
function crmTgDayBusy_(request,calendarId,date,bookings,records,unclaimed){
  const day=crmCivilDate_(date).getTime()-10800000;
  const result=request("POST","/freeBusy",{timeMin:new Date(day).toISOString(),timeMax:new Date(day+86400000).toISOString(),items:[{id:calendarId}]},{});
  const cal=result.body?.calendars?.[calendarId];
  if(result.code!==200||!cal||cal.errors?.length||!Array.isArray(cal.busy))throw Error("Calendar free/busy unavailable");
  const intervals=[];
  for(const w of cal.busy){
    const a=Date.parse(w.start),b=Date.parse(w.end);
    if(!Number.isFinite(a)||!Number.isFinite(b)||b<=a)throw Error("Malformed Calendar interval");
    const start=Math.max(0,Math.floor((a-day)/60000)),end=Math.min(1440,Math.ceil((b-day)/60000));
    if(start<end)intervals.push([start,end]);
  }
  const add=b=>{if(b===null)return;crmValidateBooking_(b);if(b.date===date&&b.status!=="cancelled")intervals.push([b.from,b.to]);};
  if(!Array.isArray(bookings)||!Array.isArray(records)||!Array.isArray(unclaimed))throw Error("Incomplete CRM inventory");
  bookings.forEach(add);
  for(const raw of records){const r=crmJournalRecord_(raw);if(r.status!=="done")[r.intent.base,r.intent.sheet,r.intent.calendar,r.intent.desired].forEach(add);}
  for(const r of unclaimed){
    if([0,1,2].some(i=>r.values[i]===""))continue;
    if(r.formulas.some(Boolean))throw Error("Formula in unclaimed interval");
    const key=crmSheetDate_(r.display[0]),a=crmSheetMinute_(r.display[1]),b=crmSheetMinute_(r.display[2]);
    if(b<=a)throw Error("Invalid unclaimed interval");
    if(key===date)intervals.push([a,b]);
  }
  return intervals;
}
function crmTgTime_(m){return String(Math.floor(m/60)).padStart(2,"0")+":"+String(m%60).padStart(2,"0");}
function crmTgPrice_(k){return (k/100).toFixed(2).replace(/\.00$/,"").replace(".",",")+" ₽";}
function crmTgQueryReply_(q,today,now,cfg,readBusy){
  if(q.error)return {text:q.error};
  const free=crmTgFreeFromBusy_(cfg,q.date,readBusy(q.date));
  const clipped=crmClipFreeWindows_(free,q.part,q.date===today?now:0,q.duration,cfg);
  const date=q.date.split("-").reverse().join(".");
  if(q.from!==null){
    const yes=clipped.some(w=>w[0]<=q.from&&w[1]>=q.to);
    const formats=q.format?[q.format]:["individual","group"];
    const prices=formats.map(format=>(format==="individual"?"Индивидуальное":"Групповое")+": "+crmTgPrice_(crmQuote_({date:q.date,from:q.from,to:q.to,format,regular:false},cfg).totalKopecks));
    return {text:[date+", "+crmTgTime_(q.from)+"–"+crmTgTime_(q.to)+" (МСК)",yes?"Время свободно":"Время занято",...prices,"Проверено сейчас. Бронирование не создано."].join("\n")};
  }
  const lines=clipped.map(w=>crmTgTime_(w[0])+"–"+crmTgTime_(w[1]));
  return {text:[date+" (МСК)",q.duration?"Окна, в которых помещается "+q.duration+" мин.":"Свободные интервалы:",...(lines.length?lines:["Подходящих свободных окон нет."]),"Для точной цены укажи время и формат. Бронирование не создано."].join("\n")};
}
