// v2 Telegram interface; admin mutation path is explicitly opt-in TEST only.
// Use a dedicated replacement TEST bot token; never poll the v1 bot concurrently.
function crmTgRole_(update,owner,admins){
  const callback=update?.callback_query,msg=callback?callback.message:update?.message,actor=callback?callback.from:msg?.from;
  if(!msg?.chat||msg.chat.type!=="private"||!Number.isSafeInteger(actor?.id)||actor.id<=0||actor.is_bot===true||msg.chat.id!==actor.id)return "guest";
  const id=String(actor.id);
  if(typeof owner==="string"&&/^\d+$/.test(owner)&&id===owner)return "owner";
  return Array.isArray(admins)&&admins.includes(id)?"admin":"guest";
}
function crmTgMenu_(role){
  const rows=[[{text:"Свободное время",callback_data:"v2|free"},{text:"Тарифы",callback_data:"v2|rates"}]];
  if(role==="owner"||role==="admin")rows.push([{text:"Расписание",callback_data:"v2|schedule"},{text:"Оплаты",callback_data:"v2|payments"}],[{text:"Арендаторы",callback_data:"v2|tenants"},{text:"Добавить аренду",callback_data:"v2|add"}]);
  if(role==="owner")rows.push([{text:"Состояние системы",callback_data:"v2|status"}]);
  return {text:"Пространство йоги\nНапиши, например: «ближайшее воскресенье», «завтра утром на 2 часа» или «суббота с 12 до 14». Время московское.",reply_markup:{inline_keyboard:rows}};
}
function crmTgStatusText_(raw,now){
  let r;try{r=JSON.parse(raw||"null");}catch(e){r=null;}
  if(!r||!Number.isFinite(Date.parse(r.at))||Date.parse(r.at)>now||now-Date.parse(r.at)>14*3600000)return "Состояние синхронизации не подтверждено: нет актуальной сверки.";
  if(typeof r.ok!=="boolean"||!["pending","unmanaged","conflicts","errors"].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0))return "Состояние синхронизации не подтверждено.";
  return ["Последняя сверка: "+r.at,r.ok&&!r.pending&&!r.unmanaged&&!r.conflicts&&!r.errors?"Последняя сверка завершена без замечаний.":"Требуется внимание.", "Незавершенных операций: "+r.pending,"Необработанных событий: "+r.unmanaged,"Конфликтов: "+r.conflicts,"Ошибок: "+r.errors,"Это отчет последней сверки, не гарантия доступности сервисов."].join("\n");
}
function crmTgDispatch_(update,env){
  const role=crmTgRole_(update,env.owner,env.admins);
  const cb=update.callback_query,msg=cb?cb.message:update.message;
  if(!msg?.chat||msg.chat.type!=="private")return null; // no personal data or bot replies in groups
  const input=cb?cb.data:msg.text;
  if(typeof input!=="string")return null;
  const key=input.trim();
  const admin=role==="admin"||role==="owner";
  if(admin&&env.uiEnabled&&env.adminCommand&&(/^(?:\/start|\/menu|\/help)(?:@\w+)?$/i.test(key)||key==="v2|menu"))return env.adminCommand(update,key);
  if(/^(?:\/start|\/menu|\/help)(?:@\w+)?$/i.test(key)||key==="v2|menu")return crmTgMenu_(role);
  if(env.adminCommand&&(key==="v2|add"||/^(?:v2\|(?:confirm|abort|ui)\||\/(?:add|move|cancel|pay|tenant)(?:@\w+)?(?:\s|$))/i.test(key))){
    if(!admin)return {text:"Доступно только администратору."};
    return env.adminCommand(update,key);
  }
  if(admin&&env.uiEnabled&&env.adminCommand&&(["v2|schedule","v2|payments","v2|tenants"].includes(key)||(!cb&&!key.startsWith("/")&&env.adminText?.(msg.from.id))))return env.adminCommand(update,key);
  if(key==="v2|free")return {text:"Напиши день и период. Например: «ближайший вторник вечером» или «завтра утром на 2 часа»."};
  if(key==="v2|rates"){
    const c=crmValidateTariff_(env.cfg),lines=["Тарифы, ₽/час (утро / день / вечер)"];
    for(const [d,day] of [["weekday","Будни"],["weekend","Выходные"]])for(const [f,label] of [["individual","индивидуальное"],["group","групповое"]])lines.push(day+", "+label+": "+c.rates[d][f].map(crmTgPrice_).join(" / "));
    return {text:lines.join("\n")};
  }
  if(key==="v2|status"||/^\/status(?:@\w+)?$/i.test(key))return {text:role==="owner"?crmTgStatusText_(env.status(),env.nowMs):"Доступно только владельцу."};
  if(["v2|schedule","v2|payments","v2|tenants","v2|add"].includes(key)){
    if(!admin)return {text:"Доступно только администратору."};
    if(key==="v2|add")return {text:"Создание через Telegram пока не включено. Используй тестовую CRM или календарь."};
    return {text:env.adminRead(key)};
  }
  if(cb)return {text:"Кнопка устарела. Открой /menu."};
  try{return crmTgQueryReply_(crmTgParseQuery_(key,env.today,env.nowMinute,env.cfg),env.today,env.nowMinute,env.cfg,env.readBusy);}
  catch(e){return {text:"Сейчас не удалось подтвердить свободное время или цену. Повтори запрос позже."};}
}
function crmTgAdminRead_(key,env,today){
  const ids=env.port.inventory().ids;
  if(key==="v2|tenants")return ["Арендаторы",...env.profiles.slice(0,20).map(p=>p.name+" — "+p.direction+(p.regular?" (постоянный)":"")),env.profiles.length>20?"Первые 20; полный список в CRM.":""].filter(Boolean).join("\n");
  if(key==="v2|schedule"){
    const rows=ids.map(id=>env.port.read("sheet",id)).filter(b=>b&&b.date===today&&b.status!=="cancelled").sort((a,b)=>a.from-b.from);
    return ["Расписание CRM на "+today+" (МСК)",...rows.slice(0,20).map(b=>crmTgTime_(b.from)+"–"+crmTgTime_(b.to)+" "+(env.profiles.find(p=>p.id===b.tenantId)?.name||"Уточнить")+" — "+b.direction+"\nID: "+b.id),rows.length?"":"Нет записей в CRM.","Не является подтверждением свободного времени."].filter(Boolean).join("\n");
  }
  if(key==="v2|payments"){
    const rows=env.payments.list().filter(p=>p.date===today);
    return ["Платежи за "+today,...rows.slice(0,20).map(p=>(p.kind==="refund"?"Возврат: ":"Поступление: ")+crmTgPrice_(p.amountKopecks)),rows.length?"":"Нет платежей.",rows.length>20?"Первые 20; полный журнал в CRM.":""].filter(Boolean).join("\n");
  }
  throw Error("Unknown admin action");
}
function crmTgTestDispatch_(update){
  const env=crmV2BoundTest_(),props=env.props;
  const today=Utilities.formatDate(new Date(),"Europe/Moscow","yyyy-MM-dd"),clock=Utilities.formatDate(new Date(),"Europe/Moscow","HH:mm");
  const admins=(props.getProperty("CRM_V2_ADMIN_IDS")||"").split(",").map(x=>x.trim()).filter(x=>/^\d+$/.test(x));
  const readBusy=date=>crmTgDayBusy_(crmGasCalendarRequest_,env.calendarId,date,
    [...env.port.inventory().ids.flatMap(id=>[env.port.read("sheet",id),env.port.read("accepted",id)])].filter(Boolean),env.journal.list(),crmUnclaimedRows_(env.sheets["Аренды"]));
  return crmTgDispatch_(update,{owner:props.getProperty("OWNER_CHAT_ID"),admins,cfg:env.tariff,today,nowMinute:crmSheetMinute_(clock),nowMs:Date.now(),
    status:()=>props.getProperty("CRM_V2_LAST_REPORT"),readBusy,adminRead:key=>crmTgAdminRead_(key,env,today),
    uiEnabled:props.getProperty("CRM_V2_TEST_WRITE_ENABLED")==="true"&&props.getProperty("CRM_V2_TELEGRAM_WRITE_ENABLED")==="true",
    adminText:id=>{const s=JSON.parse(props.getProperty("CRM_TG_UI_"+id)||"null");return !!s?.kind&&s.expires>=Date.now();},
    adminCommand:(u,key)=>crmTgAdminTest_(u,key)});
}
