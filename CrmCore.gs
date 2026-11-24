// CRM v2 isolated pure core. No Apps Script services; seed rates are kopecks/hour.
// Runtime adapters must load a validated version from CRM settings before calling quote.
function crmDefaultTariff_() {
  return {version:"2026-06-01", effectiveFrom:"2026-06-01", boundaries:[360,600,1020,1380],
    rates:{weekday:{individual:[50000,50000,100000],group:[70000,70000,100000]},
      weekend:{individual:[50000,70000,100000],group:[90000,90000,100000]}}, regularDiscountBps:1000};
}

function crmCivilDate_(key) {
  if(typeof key!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) throw Error("Invalid civil date");
  const [y,m,d]=key.split("-").map(Number);
  if(y<2000||y>9999) throw Error("Unsupported year");
  const date=new Date(Date.UTC(y,m-1,d));
  if(date.toISOString().slice(0,10)!==key) throw Error("Invalid civil date");
  return date;
}

function crmValidateTariff_(cfg) {
  if(!cfg||typeof cfg.version!=="string"||!cfg.version.trim()) throw Error("Missing tariff version");
  crmCivilDate_(cfg.effectiveFrom);
  const b=cfg.boundaries;
  if(!Array.isArray(b)||b.length!==4||!b.every((v,i)=>Number.isInteger(v)&&v>=0&&v<=1440&&(i===0||v>b[i-1]))) throw Error("Invalid time boundaries");
  for(const day of ["weekday","weekend"]) for(const format of ["individual","group"]) {
    const r=cfg.rates?.[day]?.[format];
    if(!Array.isArray(r)||r.length!==3||!r.every(v=>Number.isInteger(v)&&v>=0&&v<=10000000)) throw Error("Invalid hourly rate");
  }
  if(!Number.isInteger(cfg.regularDiscountBps)||cfg.regularDiscountBps<0||cfg.regularDiscountBps>10000) throw Error("Invalid discount");
  return cfg;
}

function crmQuote_(request,cfg) {
  crmValidateTariff_(cfg);
  if(!request||!["individual","group"].includes(request.format)||typeof request.regular!=="boolean") throw Error("Missing format or regular flag");
  const date=crmCivilDate_(request.date);
  if(request.date<cfg.effectiveFrom) throw Error("Tariff not effective on requested date");
  const [open,morningEnd,dayEnd,close]=cfg.boundaries;
  const {from,to}=request;
  if(!Number.isInteger(from)||!Number.isInteger(to)||from<open||to>close||to<=from) throw Error("Invalid booking interval");
  const dayType=[0,6].includes(date.getUTCDay())?"weekend":"weekday";
  const rates=cfg.rates[dayType][request.format];
  const boundaries=[open,morningEnd,dayEnd,close];
  const segments=["morning","day","evening"].map((part,i)=>({part,minutes:Math.max(0,Math.min(to,boundaries[i+1])-Math.max(from,boundaries[i])),hourlyKopecks:rates[i]})).filter(s=>s.minutes>0);
  const numerator=segments.reduce((sum,s)=>sum+s.minutes*s.hourlyKopecks,0);
  const discountBps=request.regular?cfg.regularDiscountBps:0;
  // Integer arithmetic; positive amounts rounded once, half up, to kopecks.
  const baseKopecks=Math.floor((numerator+30)/60);
  const totalKopecks=Math.floor((numerator*(10000-discountBps)+300000)/600000);
  return {tariffVersion:cfg.version,dayType,format:request.format,from,to,minutes:to-from,discountBps,segments,baseKopecks,totalKopecks};
}

function crmPeriod_(part,cfg) {
  crmValidateTariff_(cfg);
  const b=cfg.boundaries;
  switch(part){case "all":return [b[0],b[3]];case "morning":return [b[0],b[1]];case "day":return [b[1],b[2]];case "evening":return [b[2],b[3]];default:throw Error("Invalid time period");}
}

function crmNearestWeekday_(today,nowMinute,weekday,part,cfg) {
  const date=crmCivilDate_(today);
  if(!Number.isInteger(weekday)||weekday<0||weekday>6||!Number.isInteger(nowMinute)||nowMinute<0||nowMinute>=1440) throw Error("Invalid weekday or clock");
  const [,end]=crmPeriod_(part,cfg);
  let delta=(weekday-date.getUTCDay()+7)%7;
  if(delta===0&&nowMinute>=end) delta=7;
  date.setUTCDate(date.getUTCDate()+delta);
  return date.toISOString().slice(0,10);
}

function crmClipFreeWindows_(windows,part,notBefore,duration,cfg) {
  const [start,end]=crmPeriod_(part,cfg);
  if(!Array.isArray(windows)||!Number.isInteger(notBefore)||notBefore<0||notBefore>1440||!Number.isInteger(duration)||duration<0||duration>1440) throw Error("Invalid window query");
  let prevEnd=-1;
  const out=[];
  for(const w of windows){
    if(!Array.isArray(w)||w.length!==2||!w.every(x=>Number.isInteger(x)&&x>=0&&x<=1440)||w[1]<=w[0]||w[0]<prevEnd) throw Error("Invalid free windows");
    prevEnd=w[1]; const a=Math.max(w[0],start,notBefore),b=Math.min(w[1],end);
    if(b>a&&b-a>=duration) out.push([a,b]);
  }
  return out;
}
