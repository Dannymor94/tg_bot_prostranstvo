// Small actor-local navigation state. It contains no authority to mutate CRM;
// all resulting commands use the existing durable confirmation flow.
function crmTgUiStep_(key,isCallback,env,session,token,now){
  const reply=(text,rows=[])=>({text,reply_markup:{inline_keyboard:[...rows,[{text:"В меню",callback_data:"v2|menu"}]]}});
  const output=(text,choices,extra={})=>{
    const state={...extra,token,expires:now+15*60000,choices:choices.map(x=>x.action)};
    return {state,reply:reply(text,choices.map((x,i)=>[{text:x.label.slice(0,100),callback_data:"v2|ui|"+token+"|"+i}]))};
  };
  const prompt=(text,kind,data={})=>output(text,[],{kind,...data});
  const tenantLabel=p=>p.name+" — "+p.direction+(p.regular?" (постоянный)":"");
  const profile=id=>{const p=env.profiles.find(x=>x.id===id);if(!p)throw Error("Арендатор изменился.");return p;};
  const tenants=(page,mode)=>{
    const all=env.profiles.slice().sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id)),offset=page*8;
    const choices=all.slice(offset,offset+8).map(p=>({label:tenantLabel(p),action:{kind:"tenant",id:p.id,mode}}));
    if(page>0)choices.push({label:"Назад",action:{kind:"tenants",page:page-1,mode}});
    if(offset+8<all.length)choices.push({label:"Дальше",action:{kind:"tenants",page:page+1,mode}});
    choices.push({label:"Новый арендатор",action:{kind:"newTenant"}});
    return output((mode==="add"?"Выбери арендатора для записи":"Арендаторы")+" ("+all.length+")",choices);
  };
  const bookings=(date,page,mode)=>{
    crmCivilDate_(date);
    if(date<crmTgAddDays_(env.today,-120)||date>=crmTgAddDays_(env.today,120))throw Error("Дата вне диапазона.");
    const all=env.accepted.list().filter(b=>b.date===date&&b.status==="confirmed").sort((a,b)=>a.from-b.from||a.id.localeCompare(b.id));
    const offset=page*8,choices=all.slice(offset,offset+8).map(b=>({label:crmTgTime_(b.from)+"–"+crmTgTime_(b.to)+" "+(env.profiles.find(p=>p.id===b.tenantId)?.name||"Уточнить"),action:{kind:"booking",id:b.id,mode,revision:env.accepted.revision(b.id)}}));
    if(page>0)choices.push({label:"Предыдущие записи",action:{kind:"bookings",date,page:page-1,mode}});
    if(offset+8<all.length)choices.push({label:"Следующие записи",action:{kind:"bookings",date,page:page+1,mode}});
    if(date>crmTgAddDays_(env.today,-120))choices.push({label:"Предыдущий день",action:{kind:"bookings",date:crmTgAddDays_(date,-1),page:0,mode}});
    if(date<crmTgAddDays_(env.today,119))choices.push({label:"Следующий день",action:{kind:"bookings",date:crmTgAddDays_(date,1),page:0,mode}});
    choices.push({label:"Выбрать дату",action:{kind:"date",mode}});
    return output((mode==="pay"?"Оплаты — выбери аренду":"Расписание")+" "+date.split("-").reverse().join(".")+" (МСК)\n"+(all.length?"Выбери запись.":"Нет подтвержденных записей."),choices);
  };
  function stable(id,rev){
    const s=crmAdminReadStable_(env,id);
    if(s.revision!==rev||s.booking.status!=="confirmed")throw Error("Аренда изменилась. Открой расписание заново.");
    return s.booking;
  }
  if(key==="v2|add")return tenants(0,"add");
  if(key==="v2|tenants")return tenants(0,"view");
  if(key==="v2|schedule"||key==="v2|payments")return bookings(env.today,0,key==="v2|payments"?"pay":"schedule");
  if(key==="v2|menu"||/^\/(?:start|menu|help)(?:@\w+)?$/i.test(key))return {state:null,menu:true};
  if(key==="v2|free"||key==="v2|rates")return {state:null,pass:true};
  if(isCallback){
    const m=/^v2\|ui\|(\d{1,16})\|(\d{1,2})$/.exec(key);
    if(!m)return null;
    if(!session||session.expires<now||session.token!==m[1]||!session.choices[+m[2]])return {state:session,reply:reply("Кнопка устарела. Открой меню.")};
    const a=session.choices[+m[2]];
    if(a.kind==="tenants")return tenants(a.page,a.mode);
    if(a.kind==="newTenant")return prompt("Напиши имя, направление, формат и постоянный статус через |.\nНапример: Анна | Йога | Групповое | нет\nФормат: Групповое или Индивидуальное. Постоянный: да или нет.","newTenant");
    if(a.kind==="tenant"){
      const p=profile(a.id);
      if(a.mode==="view")return output(p.name+"\n"+p.direction+"\n"+(p.format==="group"?"Групповое":p.format==="individual"?"Индивидуальное":"Формат не указан")+"\n"+(p.regular?"Постоянный арендатор":"Обычный тариф"),[{label:"Добавить аренду",action:{kind:"tenant",id:p.id,mode:"add"}},{label:"К арендаторам",action:{kind:"tenants",page:0,mode:"view"}}]);
      return prompt("Арендатор: "+p.name+"\nНапиши дату и время, например: «ближайшая пятница с 16 до 18».","addTime",{tenant:p});
    }
    if(a.kind==="bookings")return bookings(a.date,a.page,a.mode);
    if(a.kind==="date")return prompt("Напиши дату или день недели, например «суббота» или «27.11».","date",{mode:a.mode});
    if(a.kind==="booking"){
      const b=stable(a.id,a.revision),p=profile(b.tenantId);
      const choices=[{label:"Оплатить полностью",action:{kind:"payFull",id:b.id,revision:a.revision}},{label:"Частичная оплата",action:{kind:"payPart",id:b.id,revision:a.revision}}];
      if(a.mode!=="pay")choices.push({label:"Перенести",action:{kind:"move",id:b.id,revision:a.revision}},{label:"Отменить аренду",action:{kind:"cancel",id:b.id,revision:a.revision}});
      choices.push({label:"К расписанию",action:{kind:"bookings",date:b.date,page:0,mode:a.mode}});
      let money="Стоимость требует проверки.";
      try{const m=crmAdminMoney_(env,b.id,a.revision);money="Стоимость: "+crmTgPrice_(m.quote)+"\nПолучено: "+crmTgPrice_(m.summary.paidKopecks)+"\nОстаток: "+crmTgPrice_(m.summary.balanceKopecks);}catch(e){/* do not invent a price */}
      return output(p.name+" — "+b.direction+"\n"+b.date+" "+crmTgTime_(b.from)+"–"+crmTgTime_(b.to)+" (МСК)\n"+money,choices);
    }
    if(["payFull","payPart","move","cancel"].includes(a.kind)){
      stable(a.id,a.revision);
      if(a.kind==="payFull"||a.kind==="cancel")return {state:null,command:a.kind==="cancel"?"/cancel "+a.id:"/pay "+a.id+" | полностью"};
      return prompt(a.kind==="move"?"Напиши новую дату и время.":"Введи полученную сумму в рублях.",a.kind,{id:a.id,revision:a.revision});
    }
    throw Error("Unknown navigation action");
  }
  if(!session||session.expires<now||!session.kind||key.startsWith("/"))return null;
  if(session.kind==="addTime"){
    const p=profile(session.tenant.id);
    if(JSON.stringify(p)!==JSON.stringify(session.tenant)||/[|\r\n]/.test(key))throw Error("Карточка изменилась или запрос неоднозначен.");
    return {state:null,command:"/add "+p.name+" | "+key};
  }
  if(session.kind==="move"||session.kind==="payPart"){
    stable(session.id,session.revision);
    if(/[|\r\n]/.test(key))throw Error("Укажи одно значение.");
    return {state:null,command:(session.kind==="move"?"/move ":"/pay ")+session.id+" | "+key};
  }
  if(session.kind==="date"){
    // Explicit historical dates allowed via day navigation, future search grammar for text.
    const q=crmTgParseQuery_(key,env.today,env.nowMinute,env.tariff);
    if(q.error||q.from!==null||q.duration||q.part!=="all"||q.format)throw Error("Укажи только дату.");
    return bookings(q.date,0,session.mode);
  }
  if(session.kind==="newTenant")return {state:null,command:"/tenant "+key};
  return null;
}
