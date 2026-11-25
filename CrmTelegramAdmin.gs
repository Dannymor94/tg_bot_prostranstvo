// Confirmed admin commands; caller holds ScriptLock, checks role and TEST enable flag.
// The durable command record is written before any booking or ledger mutation.
function crmAdminReadStable_(env,id){
  const b=env.port.read("accepted",id),s=env.port.read("sheet",id),c=env.port.read("calendar",id);
  if(!b||!crmSyncEqual_(b,s)||!crmSyncEqual_(b.status==="cancelled"?null:b,c)||env.journal.hasPending(id))throw Error("Аренда не синхронизирована.");
  return {booking:b,revision:env.accepted.revision(id)};
}
function crmAdminQuote_(env,b){
  const p=env.profiles.find(x=>x.id===b.tenantId);
  if(!p)throw Error("Арендатор не найден.");
  return crmQuote_({...b,regular:p.regular},env.tariff);
}
function crmAdminMoney_(env,id,revision){
  const rows=crmSheetRows_(env.sheets["Аренды"],"Аренды").filter(r=>r.values[11]===id);
  if(rows.length!==1||rows[0].formulas.some(Boolean))throw Error("Строка оплаты не подтверждена.");
  const v=rows[0].values;
  if(v[13]!==revision||typeof v[14]!=="string"||!v[14]||typeof v[6]!=="number"||v[6]<0)throw Error("Сначала проверь стоимость в CRM.");
  const quote=v[6]===0?0:crmRublesToKopecks_(v[6]);
  return {quote,summary:crmPaymentSummary_(id,quote,env.payments.list())};
}
function crmAdminCommand_(text,env,today,now,actor,token){
  const m=/^\/(add|move|cancel|pay)(?:@\w+)?\s+(.+)$/i.exec(text);
  if(!m)return null;
  const action=m[1].toLowerCase(),parts=m[2].split("|").map(x=>x.trim());
  if(parts.some(x=>!x)||parts.length!==(action==="cancel"?1:2))throw Error("Укажи данные через |.");
  crmId_(token);
  const record={token,actor,action,status:"preview",expires:now+15*60000,today};
  if(action==="add"){
    const q=crmTgParseQuery_(parts[1],today,env.nowMinute,env.tariff);
    if(q.error||q.from===null)throw Error(q.error||"Укажи точный интервал.");
    const p=crmManualBooking_({id:"tg_"+token,date:q.date,from:q.from,to:q.to,name:parts[0],format:q.format},env.profiles,env.tariff);
    if(p.kind!=="ready")throw Error("Уточни арендатора и формат в CRM.");
    if(!env.port.isAvailable(p.booking))throw Error("Время занято.");
    record.before=null;record.revision=0;record.desired=p.booking;record.quote=p.quote.totalKopecks;record.tariffVersion=p.quote.tariffVersion;
  }else{
    const id=crmId_(parts[0]),stable=crmAdminReadStable_(env,id),b=stable.booking;
    if(b.status!=="confirmed")throw Error("Нужна подтвержденная аренда.");
    record.before=b;record.revision=stable.revision;
    if(action==="move"){
      const q=crmTgParseQuery_(parts[1],today,env.nowMinute,env.tariff);
      if(q.error||q.from===null||q.format)throw Error(q.error||"Укажи только новую дату и время.");
      record.desired=crmBookingSnapshot_({...b,date:q.date,from:q.from,to:q.to});
      if(crmSyncEqual_(b,record.desired))throw Error("Время не изменилось.");
      if(!env.port.isAvailable(record.desired))throw Error("Время занято.");
      const quote=crmAdminQuote_(env,record.desired);record.quote=quote.totalKopecks;record.tariffVersion=quote.tariffVersion;
    }else if(action==="cancel"){
      record.desired=crmBookingSnapshot_({...b,status:"cancelled"});
    }else{
      const money=crmAdminMoney_(env,id,stable.revision);
      const raw=parts[1].toLowerCase();
      if(raw!=="полностью"&&!/^\d{1,8}(?:[.,]\d{1,2})?$/.test(raw))throw Error("Укажи сумму в рублях или «полностью».");
      const amount=raw==="полностью"?money.summary.balanceKopecks:crmRublesToKopecks_(Number(raw.replace(",",".")));
      if(amount<=0||amount>money.summary.balanceKopecks)throw Error("Сумма превышает остаток или уже оплачено.");
      record.quote=money.quote;record.paid=money.summary.paidKopecks;
      record.payment=crmPaymentEntry_({id:"tgpay_"+token,bookingId:id,date:today,kind:"receipt",amountKopecks:amount,actor:"tg:"+actor});
    }
  }
  return record;
}
function crmAdminPreview_(r,env){
  const b=r.desired||r.before,name=env.profiles.find(p=>p.id===b.tenantId)?.name||"Уточнить";
  const label={add:"Создать аренду",move:"Перенести аренду",cancel:"Отменить аренду",pay:"Отметить поступление"}[r.action];
  const lines=[label,name+" — "+b.direction,b.date+" "+crmTgTime_(b.from)+"–"+crmTgTime_(b.to)+" (МСК)"];
  if(r.action==="add")lines.push("Стоимость: "+crmTgPrice_(r.quote));
  if(r.action==="move")lines.push("Новый расчет: "+crmTgPrice_(r.quote)+". Старая согласованная цена сохраняется до проверки в CRM.");
  if(r.action==="cancel")lines.push("История платежей сохранится; возврат отдельно.");
  if(r.action==="pay")lines.push("Поступление: "+crmTgPrice_(r.payment.amountKopecks));
  return {text:lines.join("\n"),reply_markup:{inline_keyboard:[[{text:"Подтвердить",callback_data:"v2|confirm|"+r.token},{text:"Не выполнять",callback_data:"v2|abort|"+r.token}]]}};
}
function crmAdminExecute_(env,r,save,now,actor){
  if(r.actor!==actor)throw Error("Подтверждение принадлежит другому пользователю.");
  if(r.status==="done")return r;
  if(r.status==="aborted"||r.status==="preview"&&now>r.expires)throw Error("Подтверждение устарело.");
  if(!["preview","started"].includes(r.status))throw Error("Недопустимое состояние.");
  const id=(r.desired||r.before).id;
  if(r.status==="preview"){
    if(r.action==="add"){
      if(["sheet","calendar","accepted"].some(t=>env.port.read(t,id)!==null)||env.journal.hasPending(id))throw Error("ID уже занят.");
    }else{
      const stable=crmAdminReadStable_(env,id);
      if(stable.revision!==r.revision||!crmSyncEqual_(stable.booking,r.before))throw Error("Аренда изменилась. Создай новый запрос.");
    }
    if(r.action==="add"||r.action==="move"){
      if(r.desired.date<env.today||r.desired.date===env.today&&r.desired.from<env.nowMinute)throw Error("Время уже прошло.");
      const q=crmAdminQuote_(env,r.desired);
      if(q.totalKopecks!==r.quote||q.tariffVersion!==r.tariffVersion||!env.port.isAvailable(r.desired))throw Error("Цена или занятость изменилась.");
    }
    if(r.action==="pay"){
      const m=crmAdminMoney_(env,id,r.revision);
      if(m.quote!==r.quote||m.summary.paidKopecks!==r.paid)throw Error("Оплата изменилась. Создай новый запрос.");
    }
    r={...r,status:"started"};save(r);
  }
  if(r.action==="pay"){
    const existing=env.payments.list().find(p=>p.id===r.payment.id);
    if(existing){
      if(JSON.stringify(crmPaymentEntry_(existing))!==JSON.stringify(r.payment))throw Error("Конфликт ID платежа.");
    }else{
      const stable=crmAdminReadStable_(env,id),m=crmAdminMoney_(env,id,r.revision);
      if(stable.revision!==r.revision||!crmSyncEqual_(stable.booking,r.before)||m.quote!==r.quote||m.summary.paidKopecks!==r.paid)throw Error("Оплата или аренда изменилась.");
      const name=env.profiles.find(p=>p.id===r.before.tenantId)?.name;
      env.payments.append(r.before,r.quote,r.payment,{source:"telegram",tenantName:name});
    }
  }else{
    const op="tgop_"+r.token,previous=env.port.load(op);
    if(previous){
      if(!crmSyncEqual_(previous.intent.desired,r.desired)||!crmSyncEqual_(previous.intent.base,r.before))throw Error("Конфликт операции.");
      if(crmRunSync_(env.port,previous.intent).status!=="done")throw Error("Требуется сверка.");
    }else{
      const base=env.port.read("accepted",id),s=env.port.read("sheet",id),c=env.port.read("calendar",id);
      const desiredCal=r.desired.status==="cancelled"?null:r.desired;
      if(crmSyncEqual_(base,r.desired)&&crmSyncEqual_(s,r.desired)&&crmSyncEqual_(c,desiredCal)){
        // A reconciliation pass may have finished the staged write after a lost response.
        if(env.accepted.revision(id)!==r.revision+1)throw Error("Ревизия изменилась.");
      }else{
        if(!crmSyncEqual_(base,r.before)||env.accepted.revision(id)!==r.revision||!crmSyncEqual_(c,r.before)||
           (!crmSyncEqual_(s,r.before)&&!crmSyncEqual_(s,r.desired))||env.journal.hasPending(id))throw Error("Аренда изменилась.");
        if(!env.port.isAvailable(r.desired))throw Error("Время занято.");
        if(!crmSyncEqual_(s,r.desired))env.port.compareAndWrite("sheet",id,s,r.desired);
        const intent=crmSyncIntent_({id:op,base:r.before,sheet:r.desired,calendar:r.before,calendarDeleted:false});
        if(intent.kind!=="intent"||crmRunSync_(env.port,intent.intent).status!=="done")throw Error("Требуется сверка.");
      }
    }
  }
  r={...r,status:"done"};save(r);return r;
}
