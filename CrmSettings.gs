// Read the native v2 TEST settings layout. No defaults on malformed input.
function crmReadSettings_(sheet){
  if(!sheet||sheet.getName()!=="Настройки"||sheet.getLastColumn()!==9)throw Error("Settings schema mismatch");
  const range=sheet.getRange(1,1,10,9),v=range.getValues(),d=range.getDisplayValues();
  if(range.getFormulas().some(r=>r.some(Boolean)))throw Error("Formula in settings");
  const headers=["Параметр","Значение","Описание","","Тип дня","Формат","Утро, ₽/ч","День, ₽/ч","Вечер, ₽/ч"];
  if(JSON.stringify(v[0])!==JSON.stringify(headers))throw Error("Settings header mismatch");
  const labels=["Версия тарифа","Действует с","Открытие","Конец утра","Конец дня","Закрытие","Скидка постоянным","Часовой пояс","Режим"];
  if(labels.some((s,i)=>v[i+1][0]!==s))throw Error("Settings labels mismatch");
  if(v[8][1]!=="Europe/Moscow"||v[9][1]!=="TEST")throw Error("Unsupported settings environment");
  const discount=v[7][1];
  if(typeof discount!=="number"||!Number.isFinite(discount)||Math.abs(discount*10000-Math.round(discount*10000))>0.000001)throw Error("Invalid discount precision");
  const rates={weekday:{},weekend:{}};
  const pairs=[["Будни","Индивидуальное","weekday","individual"],["Будни","Групповое","weekday","group"],["Выходные","Индивидуальное","weekend","individual"],["Выходные","Групповое","weekend","group"]];
  for(let i=0;i<pairs.length;i++){
    const [day,format,dayKey,formatKey]=pairs[i],r=v[i+1];
    if(r[4]!==day||r[5]!==format)throw Error("Tariff row mismatch");
    rates[dayKey][formatKey]=r.slice(6,9).map(x=>{
      if(x===0)return 0;
      return crmRublesToKopecks_(x);
    });
  }
  return crmValidateTariff_({version:crmSheetSafeText_(d[1][1]).trim(),effectiveFrom:crmSheetDate_(d[2][1]),
    boundaries:[3,4,5,6].map(i=>crmSheetMinute_(d[i][1])),rates,regularDiscountBps:Math.round(discount*10000)});
}
