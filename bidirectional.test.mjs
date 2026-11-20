import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const legacy = fs.readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
const bidir = fs.readFileSync(new URL('./Bidirectional.gs', import.meta.url), 'utf8');
new vm.Script(legacy);
new vm.Script(bidir);
const context = vm.createContext({
  Utilities: { formatDate(d, _tz, format) {
    if (format === 'HH:mm') return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } },
});
vm.runInContext(legacy, context);
vm.runInContext(bidir, context);
const run = s => vm.runInContext(s, context);
const plain = x => JSON.parse(JSON.stringify(x));

test('legacy (+30) marker inherits following name and merges contiguous hours', () => {
  const cells = Array(16).fill('');
  cells[9] = '(+30) Мин'; cells[10] = 'Марина Николаевна'; cells[11] = 'Марина Николаевна';
  context.fixture = cells;
  assert.deepEqual(plain(run("bdBookings_(fixture,'2026-12-11')")),
    [{ title: 'Марина Николаевна', start: 930, end: 1080 }]);
});

test('dangling half-hour marker fails closed', () => {
  const cells = Array(16).fill(''); cells[9] = '(+30) Мин';
  context.fixture = cells;
  assert.throws(() => run("bdBookings_(fixture,'2026-12-11')"), /next name/);
});

test('calendar event projects back to same half-hour marker and name', () => {
  const result = run(`bdProject_([{id:'a',title:'Марина Николаевна',
    start:new Date(2026,11,11,15,30).getTime(),
    end:new Date(2026,11,11,17).getTime()}],'2026-12-11')`);
  assert.equal(result.cells[9], '(+30) Мин');
  assert.equal(result.cells[10], 'Марина Николаевна');
  assert.equal(result.conflicts.length, 0);
});

test('simultaneous edits conflict, never overwrite', () => {
  const original = Array(16).fill(''); original[9] = 'Ольга';
  const updated = original.slice(); updated[9] = 'Дарья';
  context.current = updated;
  context.prior = { cells: original, events: [{id:'a',title:'Ольга',start:100,end:200}] };
  const plan = run(`bdPlanDay_('2026-12-11',current,
    [{id:'a',title:'Ольга',start:new Date(2026,11,11,16).getTime(),
      end:new Date(2026,11,11,17).getTime()}],prior)`);
  assert.equal(plan.kind, 'conflict');
});

test('an unchanged but divergent checkpoint is never accepted as healthy', () => {
  const cells=Array(16).fill(''); cells[9]='Ольга';
  const meta={id:'a',title:'Ольга',
    start:new Date(2026,11,11,16).getTime(),end:new Date(2026,11,11,17).getTime()};
  context.current=cells; context.meta=meta;
  const plan=run("bdPlanDay_('2026-12-11',current,[meta],{cells:current,events:[meta]})");
  assert.equal(plan.kind,'conflict');
  assert.match(plan.problems[0],/divergent/);
});

test('two calendar bookings within one hour are rejected', () => {
  const result = run(`bdProject_([
    {id:'a',title:'А',start:new Date(2026,11,11,15).getTime(),end:new Date(2026,11,11,15,30).getTime()},
    {id:'b',title:'Б',start:new Date(2026,11,11,15,30).getTime(),end:new Date(2026,11,11,16).getTime()}
    ],'2026-12-11')`);
  assert.equal(result.conflicts.length, 1);
});

test('empty baseline selects the changed source deterministically', () => {
  const sheet = Array(16).fill(''); sheet[9] = 'Ольга';
  context.cells = sheet;
  const fromSheet = run("bdPlanDay_('2026-12-11',cells,[],null)");
  assert.equal(fromSheet.kind, 'sheet');
  const fromCal = run(`bdPlanDay_('2026-12-11',Array(16).fill(''),[
    {id:'x',title:'Ольга',start:new Date(2026,11,11,15).getTime(),
     end:new Date(2026,11,11,16).getTime()}],null)`);
  assert.equal(fromCal.kind, 'calendar');
});

test('bootstrap can resume an exact subset of already imported events', () => {
  const cells = Array(16).fill(''); cells[9]='Ольга';cells[12]='Нияти Гельм';
  context.current=cells;
  const plan=run(`bdPlanDay_('2026-12-11',current,[{
    id:'created-before-crash',title:'Ольга',
    start:new Date(2026,11,11,15).getTime(),
    end:new Date(2026,11,11,16).getTime()}],null,true)`);
  assert.equal(plan.kind,'sheet');
  assert.equal(plan.bookings.length,2);
});

test('Sheet changes elsewhere preserve Calendar end at :30', () => {
  const start = run('new Date(2026,11,11,15,30).getTime()');
  const end = run('new Date(2026,11,11,16,30).getTime()');
  let deleted=0,created=0;
  const e={meta:{title:'Ольга',start,end},event:{deleteEvent:()=>{deleted++}}};
  context.existingEvents=[e];
  context.fakeCalendar={createEvent:()=>{created++}};
  const result=run(`bdCreateFromSheet_(fakeCalendar,'2026-12-11',
    [{title:'Ольга',start:930,end:1020}],existingEvents)`);
  assert.equal(result.created,0);assert.equal(result.deleted,0);
  assert.equal(created,0);assert.equal(deleted,0);
});

test('isolated 15:30-16:00 keeps own name even before a different booking', () => {
  const cells = Array(16).fill('');
  cells[9] = '(+30) Мин';
  cells[10] = 'Марина';
  context.fixture = cells;
  context.known = [{id:'a', title:'Ольга',
    start:new Date(2026,11,10,15,30).getTime(),
    end:new Date(2026,11,10,16).getTime()}];
  assert.deepEqual(plain(run("bdBookings_(fixture,'2026-12-10',known)")),
    [{title:'Ольга', start:930, end:960},
     {title:'Марина', start:960, end:1020}]);
});

test('renaming a Sheet booking preserves original Calendar event identity', () => {
  let title = 'Ольга', edits = 0, deleted = 0, created = 0;
  const start = new Date(2026,11,10,15).getTime();
  const end = new Date(2026,11,10,16).getTime();
  const meta = {id:'stable-id', title, start, end};
  context.currentEvents = [{
    meta, event: {getId:()=>meta.id,getTitle:()=>title,
      getStartTime:()=>new Date(start),getEndTime:()=>new Date(end),
      setTitle:v => {title=v; edits++},setTime:()=>{edits++},
      deleteEvent:()=>{deleted++}},
  }];
  context.previous = {events:[meta]};
  context.fakeCalendar = {createEvent:()=>{created++}};
  const result = run(`bdCreateFromSheet_(fakeCalendar,'2026-12-10',
    [{title:'Марина',start:900,end:960}],currentEvents,previous)`);
  assert.equal(result.updated,1);
  assert.equal(title,'Марина');
  assert.equal(edits,1); assert.equal(deleted,0); assert.equal(created,0);
});

test('unknown Calendar event cannot be deleted by a Sheet edit', () => {
  const meta = {id:'not-in-snapshot',title:'Чужая бронь',
    start:new Date(2026,11,10,19).getTime(),
    end:new Date(2026,11,10,20).getTime()};
  let deleted = 0, created = 0;
  context.currentEvents = [{meta,event:{deleteEvent:()=>{deleted++}}}];
  context.previous = {events:[]};
  context.fakeCalendar = {createEvent:()=>{created++}};
  assert.throws(() => run(`bdCreateFromSheet_(fakeCalendar,'2026-12-10',
    [{title:'Ольга',start:900,end:960}],currentEvents,previous)`), /absent from/);
  assert.equal(deleted,0); assert.equal(created,0);
});

test('combined rename and move cannot silently repurpose Calendar guests', () => {
  const start=new Date(2026,11,10,15).getTime(),end=new Date(2026,11,10,16).getTime();
  const old={id:'guest-event',title:'Ольга',start,end};
  let edits=0;
  context.currentEvents=[{meta:old,event:{setTitle:()=>{edits++},
    setTime:()=>{edits++},deleteEvent:()=>{edits++}}}];
  context.previous={events:[old]};context.fakeCalendar={createEvent:()=>{edits++}};
  assert.throws(()=>run(`bdCreateFromSheet_(fakeCalendar,'2026-12-10',
    [{title:'Дарья',start:1140,end:1200}],currentEvents,previous)`),/ambiguous/);
  assert.equal(edits,0);
});

test('bulk deletion and recurring-event deletion fail closed', () => {
  const start=new Date(2026,11,10,15).getTime();
  let deleted=0;
  const events=[0,1,2].map(i=>({id:String(i),title:'Ольга',
    start:start+i*3600000,end:start+(i+1)*3600000}));
  context.currentEvents=events.map(meta=>({meta,event:{
    deleteEvent:()=>{deleted++},isRecurringEvent:()=>false}}));
  context.previous={events};context.fakeCalendar={createEvent:()=>{}};
  assert.throws(()=>run(`bdCreateFromSheet_(fakeCalendar,'2026-12-10',
    [],currentEvents,previous)`),/bulk deletion/);
  assert.equal(deleted,0);
  context.currentEvents=[{meta:events[0],event:{
    deleteEvent:()=>{deleted++},isRecurringEvent:()=>true}}];
  assert.throws(()=>run(`bdCreateFromSheet_(fakeCalendar,'2026-12-10',
    [],currentEvents,previous)`),/recurring/);
  assert.equal(deleted,0);
});

test('adjacent same-name events remain separate and fail safe on ambiguous Sheet edit', () => {
  const a = new Date(2026,11,10,15).getTime();
  const b = new Date(2026,11,10,16).getTime();
  const c = new Date(2026,11,10,17).getTime();
  let deleted = 0, created = 0;
  const events = [{id:'a',title:'Ольга',start:a,end:b},
    {id:'b',title:'Ольга',start:b,end:c}];
  context.currentEvents = events.map(meta=>({meta,event:{deleteEvent:()=>{deleted++}}}));
  context.previous = {events};
  context.fakeCalendar = {createEvent:()=>{created++}};
  assert.throws(() => run(`bdCreateFromSheet_(fakeCalendar,'2026-12-10',
    [{title:'Ольга',start:900,end:1020}],currentEvents,previous)`), /ambiguous/);
  assert.equal(deleted,0);assert.equal(created,0);
});

test('snapshot boundaries keep two adjacent same-name calendar events distinct', () => {
  const cells=Array(16).fill(''); cells[9]='Ольга';cells[10]='Ольга';
  context.fixture=cells;
  context.known=[
    {id:'a',title:'Ольга',start:new Date(2026,11,10,15).getTime(),
      end:new Date(2026,11,10,16).getTime()},
    {id:'b',title:'Ольга',start:new Date(2026,11,10,16).getTime(),
      end:new Date(2026,11,10,17).getTime()},
  ];
  assert.deepEqual(plain(run("bdBookings_(fixture,'2026-12-10',known)")),[
    {title:'Ольга',start:900,end:960},
    {title:'Ольга',start:960,end:1020},
  ]);
});

test('Telegram does not round an exact Calendar 15:00-15:30 booking to 16:00', () => {
  const oldSheet = context.sheet_, oldRows = context.dateRows_;
  const oldCal = context.calendar_, oldProps = context.PropertiesService;
  const oldLock = context.LockService;
  const cells=Array(16).fill(''); cells[9]='Ольга';
  const e={isAllDayEvent:()=>false,
    getId:()=> 'exact-half',getTitle:()=> 'Ольга',
    getStartTime:()=>new Date(2026,11,10,15),
    getEndTime:()=>new Date(2026,11,10,15,30)};
  context.sheet_=()=>({getRange:()=>({getDisplayValues:()=>[cells]})});
  context.dateRows_=()=>({'2026-12-10':2055});
  context.PropertiesService={getScriptProperties:()=>({
    getProperties:()=>({}),getProperty:k=>k==='BIDIR_ACTIVE'?'true':null})};
  context.LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})};
  context.calendar_=()=>({getEvents:()=>[e]});
  const answer=run("checkAvailability_({date:'2026-12-10',from:930,to:960},{})");
  assert.equal(answer.free,true);
  context.sheet_=oldSheet; context.dateRows_=oldRows;
  context.calendar_=oldCal; context.PropertiesService=oldProps;
  context.LockService=oldLock;
});

test('Telegram refuses to claim free while a bidirectional write is pending', () => {
  const saved={sheet_:context.sheet_,dateRows_:context.dateRows_,
    calendar_:context.calendar_,PropertiesService:context.PropertiesService,
    LockService:context.LockService};
  context.sheet_=()=>({getRange:()=>({getDisplayValues:()=>[Array(16).fill('')]})});
  context.dateRows_=()=>({'2026-12-10':2055});
  context.calendar_=()=>({getEvents:()=>[]});
  context.PropertiesService={getScriptProperties:()=>({
    getProperties:()=>({'BD_PENDING_2026-12-10':'unfinished'}),
    getProperty:k=>k==='BIDIR_ACTIVE'?'true':null})};
  context.LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})};
  assert.throws(()=>run("checkAvailability_({date:'2026-12-10',from:900,to:960},{})"),
    /pending or paused/);
  Object.assign(context,saved);
});

test('test-only import guard refuses production ID', () => {
  context.config_ = () => ({ spreadsheetId: 'PRODUCTION', calendarId: 'PRODUCTION' });
  context.PropertiesService = {getScriptProperties:()=>({getProperty:()=>null})};
  assert.throws(() => run('bdImportExistingBookings()'), /TEST-only/);
});

test('full loop: import, Sheet edit, Calendar move, delete, idempotency', () => {
  const today = run('localDay_(new Date())');
  const cells = [Array(16).fill(''),Array(16).fill('')];
  cells[0][9] = '(+30) Мин'; cells[0][10] = 'Ольга';
  cells[1][12] = 'Нияти Гельм';
  const tomorrow = run('new Date(localDay_(new Date()).getTime() + 86400000)');
  const storage = new Map([
    ['CALENDAR_ID','48dcda42a1404258847154571d9d674473f8580900e3fd5e7b6ca049cbc863b8@group.calendar.google.com'],
    ['SPREADSHEET_ID','1FNufCunHlY5m4HAzBnRcZKRJtM7YfKKHcDehN8SGUxo'],
    ['SHEET_LABEL','Даниил'],['SYNC_DAYS','30'],['WRITE_ENABLED','true'],
  ]);
  const props = {
    getProperty: k => storage.get(k) || null,
    setProperty: (k, v) => storage.set(k,String(v)),
    deleteProperty: k => storage.delete(k),
    getProperties: () => Object.fromEntries(storage),
  };
  const sheet = {
    getLastRow: () => 7,
    getParent:()=>auditBook,
    getRange(row,col,height=1,width=1) {
      if(row===1&&col===2) return {getDisplayValues:()=>[Array.from({length:16},(_,i)=>`${i+6}:00-${i+7}:00`)]};
      if(row===6&&col===1) return {getValues:()=>[[today],[tomorrow]]};
      if(row>=6&&row<=7&&col===2&&width===16) return {
        getDisplayValues:()=>cells.slice(row-6,row-6+height).map(x=>x.slice())};
      if(row>=6&&row<=7&&col>=2&&col<=17) return {
        getDisplayValue:()=>cells[row-6][col-2],
        getA1Notation:()=>String.fromCharCode(65+col-1)+row,
        setValue:v=>{cells[row-6][col-2]=v},
      };
      throw Error('Unexpected Sheet range '+[row,col,height,width]);
    },
  };
  const auditRows=[];
  const auditTab={appendRow:row=>auditRows.push(row),hideSheet:()=>{}};
  const auditBook={getSheetByName:()=>auditRows.length?auditTab:null,
    insertSheet:()=>auditTab};
  let nextID=0;
  const events = [];
  const calendar = {
    createEvent(title,start,end,options={}) {
      const e={id:'event-'+(++nextID),title,start:new Date(start),end:new Date(end),description:options.description||''};
      const obj={
        getId:()=>e.id,getTitle:()=>e.title,getStartTime:()=>e.start,getEndTime:()=>e.end,
        isAllDayEvent:()=>false,deleteEvent:()=>{events.splice(events.indexOf(obj),1);},
        setTime:(s,t)=>{e.start=new Date(s);e.end=new Date(t);},
        setTitle:t=>{e.title=t;},
      };
      events.push(obj); return obj;
    },
    getEvents(from,to){return events.filter(e=>e.getStartTime()<to&&e.getEndTime()>from);},
  };
  context.config_=() => ({spreadsheetId:storage.get('SPREADSHEET_ID'),calendarId:storage.get('CALENDAR_ID')});
  context.PropertiesService={getScriptProperties:()=>props};
  context.Session={getScriptTimeZone:()=> 'Europe/Moscow'};
  context.CalendarApp={getCalendarById:()=>calendar};
  context.SpreadsheetApp={openById:()=>({getSpreadsheetTimeZone:()=> 'Europe/Moscow',getSheetByName:()=>sheet}),flush:()=>{}};
  context.LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})};
  context.Logger={log:()=>{}};
  const imported = run('bdImportExistingBookings()');
  assert.equal(imported.applied,true); assert.equal(imported.created,2);
  assert.equal(auditRows.length,3); // header + two recoverable pre-write records
  assert.equal(events.length,2);
  assert.equal(storage.get('BIDIR_ACTIVE'),'true');
  assert.equal(run('bdTimer()').days,0);

  // Sheet change should update Calendar without changing the user's Sheet cells.
  cells[0][10]='Марина';
  const dayKey=run('dayKey_(new Date())');
  context.changedKey=dayKey;
  const changed=run("bdReconcile_('sheet-edit',[changedKey])");
  assert.equal(changed.created,0);assert.equal(changed.deleted,0);assert.equal(changed.updated,1);
  assert.ok(events.some(e=>e.getTitle()==='Марина'));

  // Moving that Calendar booking changes its old and new hourly Sheet cells.
  const moved=events.find(e=>e.getTitle()==='Марина');
  moved.setTime(new Date(today.getFullYear(),today.getMonth(),today.getDate(),17),
    new Date(today.getFullYear(),today.getMonth(),today.getDate(),18));
  const calendarMoved=run("bdReconcile_('calendar-edit')");
  assert.equal(calendarMoved.sheetCells,3);
  assert.equal(cells[0][9],'');assert.equal(cells[0][10],'');assert.equal(cells[0][11],'Марина');

  moved.deleteEvent();
  const deleted=run("bdReconcile_('calendar-edit')");
  assert.equal(deleted.sheetCells,1); assert.equal(cells[0][11],'');
  assert.equal(run('bdTimer()').days,0);
  assert.equal(cells[1][12],'Нияти Гельм');
});

test('production write requires exact approval for target Sheet and Calendar', () => {
  context.otherCfg={spreadsheetId:'prod-sheet',calendarId:'prod-calendar'};
  let approval=null;
  context.guardProps={getProperty:k=>k==='WRITE_ENABLED'?'true':
    k==='BIDIR_PRODUCTION_APPROVED'?approval:null};
  assert.throws(()=>run('bdWriteGuard_(otherCfg,guardProps)'), /not explicitly approved/);
  approval='prod-sheet|prod-calendar';
  assert.doesNotThrow(()=>run('bdWriteGuard_(otherCfg,guardProps)'));
  context.guardProps={getProperty:k=>k==='WRITE_ENABLED'?'false':
    k==='BIDIR_PRODUCTION_APPROVED'?approval:null};
  assert.throws(()=>run('bdWriteGuard_(otherCfg,guardProps)'), /WRITE_ENABLED/);
});

test('technical snapshot cleanup keeps recent dates and unrelated script properties', () => {
  const state=new Map([
    ['BD_STATE_2026-01-01','old'],['BD_STATE_2026-11-18','recent'],
    ['TELEGRAM_TOKEN','redacted-test-placeholder'],
  ]);
  context.cleanProps={getProperty:k=>state.get(k)||null,
    getProperties:()=>Object.fromEntries(state),
    deleteProperty:k=>state.delete(k),
    setProperty:(k,v)=>state.set(k,String(v))};
  run('bdCleanupState_(cleanProps,new Date(2026,10,20))');
  assert.equal(state.has('BD_STATE_2026-01-01'),false);
  assert.equal(state.get('BD_STATE_2026-11-18'),'recent');
  assert.ok(state.has('TELEGRAM_TOKEN'));
});

test('Calendar API delta moves an event across dates and touches both days', () => {
  context.deltaItems=[{id:'api-a',status:'confirmed',
    start:{dateTime:'2026-12-11T14:30:00+03:00'}}];
  context.apiIndex={'api-a':'2026-12-10'};
  const plan=plain(run("bdApiChangePlan_(deltaItems,apiIndex,'2026-11-20',false)"));
  assert.deepEqual(plan.keys,['2026-12-10','2026-12-11']);
  assert.equal(plan.index['api-a'],'2026-12-11');
});

test('Calendar API tombstone without start clears its indexed old date', () => {
  context.deltaItems=[{id:'api-a',status:'cancelled'}];
  context.apiIndex={'api-a':'2026-12-10','api-b':'2026-12-12'};
  const plan=plain(run("bdApiChangePlan_(deltaItems,apiIndex,'2026-11-20',false)"));
  assert.deepEqual(plan.keys,['2026-12-10']);
  assert.deepEqual(plan.index,{'api-b':'2026-12-12'});
});

test('410 full refresh revisits removed, surviving, and newly created future days', () => {
  context.deltaItems=[{id:'api-b',status:'confirmed',
    start:{dateTime:'2027-04-11T12:00:00+03:00'}}];
  context.apiIndex={'deleted-in-gap':'2027-03-10','api-b':'2027-04-10'};
  const plan=plain(run("bdApiChangePlan_(deltaItems,apiIndex,'2026-11-20',true)"));
  assert.deepEqual(plan.keys,['2027-03-10','2027-04-10','2027-04-11']);
  assert.deepEqual(plan.index,{'api-b':'2027-04-11'});
});

test('Calendar API refuses future recurring series rather than silently misprojecting', () => {
  context.deltaItems=[{id:'series-1',status:'confirmed',recurrence:['RRULE:FREQ=WEEKLY'],
    start:{dateTime:'2026-12-11T14:00:00+03:00'}}];
  assert.throws(()=>run("bdApiChangePlan_(deltaItems,{},'2026-11-20',false)"),
    /Recurring/);
});

test('Calendar API syncToken pagination and authorization are bounded', () => {
  const urls=[];
  const page1={items:[{id:'a'}],nextPageToken:'next-page'};
  const page2={items:[{id:'b'}],nextSyncToken:'new-sync'};
  context.ScriptApp={getOAuthToken:()=> 'fake-oauth-token'};
  context.UrlFetchApp={fetch:(url,options)=>{
    assert.equal(options.headers.Authorization,'Bearer fake-oauth-token');
    urls.push(url);
    return {getResponseCode:()=>200,getContentText:()=>JSON.stringify(
      urls.length===1?page1:page2)};
  }};
  const result=plain(run("bdApiList_('test@example.com','old-sync')"));
  assert.deepEqual(result.items,[{id:'a'},{id:'b'}]);
  assert.equal(result.token,'new-sync');
  assert.match(urls[0],/syncToken=old-sync/);
  assert.match(urls[1],/pageToken=next-page/);
});

test('Calendar API 410 reinitializes from full data without advancing token yet', () => {
  const previous=context.bdApiList_;
  const calls=[];
  context.bdApiList_=(_calendar, token)=>{
    calls.push(token);
    if (token) { const err=Error('410');err.httpStatus=410;throw err; }
    return {items:[{id:'api-a',status:'confirmed',
      start:{dateTime:'2026-12-10T11:00:00+03:00'}}],token:'fresh-token'};
  };
  const properties=new Map([['BD_CAL_SYNC_TOKEN','stale-token'],
    ['BD_API_deleted','2026-12-12']]);
  context.apiProps={getProperty:k=>properties.get(k)||null,
    getProperties:()=>Object.fromEntries(properties)};
  context.deltaCfg={calendarId:'test@example.com'};
  const result=plain(run('bdCalendarDelta_(deltaCfg,apiProps,new Date(2026,10,20))'));
  assert.deepEqual(calls,['stale-token',null]);
  assert.deepEqual(result.keys,['2026-12-10','2026-12-12']);
  assert.equal(result.token,'fresh-token');
  assert.equal(properties.get('BD_CAL_SYNC_TOKEN'),'stale-token');
  context.bdApiList_=previous;
});

test('Calendar delta checkpoint writes event index before advancing sync token', () => {
  const values=new Map([['BD_API_gone','2026-12-01'],
    ['BD_API_old','2026-12-10'],['BD_CAL_SYNC_TOKEN','old-token']]);
  const operations=[];
  context.apiProps={getProperties:()=>Object.fromEntries(values),
    setProperty:(k,v)=>{operations.push(k);values.set(k,v)},
    deleteProperty:k=>{operations.push(k);values.delete(k)}};
  context.deltaResult={index:{old:'2026-12-11',new:'2026-12-14'},token:'new-token'};
  run('bdCommitCalendarDelta_(apiProps,deltaResult)');
  assert.equal(operations.at(-1),'BD_CAL_SYNC_TOKEN');
  assert.equal(values.get('BD_API_old'),'2026-12-11');
  assert.equal(values.has('BD_API_gone'),false);
  assert.equal(values.get('BD_CAL_SYNC_TOKEN'),'new-token');
});

test('Calendar API empty incremental page is a valid no-change response', () => {
  const original={ScriptApp:context.ScriptApp,UrlFetchApp:context.UrlFetchApp};
  context.ScriptApp={getOAuthToken:()=> 'fake-token'};
  context.UrlFetchApp={fetch:()=>({getResponseCode:()=>200,
    getContentText:()=>JSON.stringify({nextSyncToken:'next-token'})})};
  const result=plain(run("bdApiList_('test@example.com','old-token')"));
  assert.deepEqual(result,{items:[],token:'next-token'});
  Object.assign(context,original);
});

test('Calendar delta commits only after a successful reconciliation and blocks conflicts', () => {
  const names=['bdCalendarDelta_','bdReadDays_','bdCalendarDays_','config_',
    'sheet_','calendar_','LockService','PropertiesService','Logger'];
  const original=Object.fromEntries(names.map(name=>[name,context[name]]));
  const values=new Map([['WRITE_ENABLED','true'],['BIDIR_ACTIVE','true']]);
  const props={getProperty:k=>values.get(k)||null,
    getProperties:()=>Object.fromEntries(values),
    setProperty:(k,v)=>values.set(k,String(v)),
    deleteProperty:k=>values.delete(k)};
  const key='2026-12-10';
  context.bdCalendarDelta_=()=>({keys:[key],token:'new-token',
    index:{'api-event':key},full:false});
  context.bdReadDays_=()=>({[key]:{row:2055,cells:Array(16).fill('')}});
  context.bdCalendarDays_=()=>({grouped:{[key]:[]},unsupported:[]});
  context.config_=()=>({spreadsheetId:'1FNufCunHlY5m4HAzBnRcZKRJtM7YfKKHcDehN8SGUxo',
    calendarId:'48dcda42a1404258847154571d9d674473f8580900e3fd5e7b6ca049cbc863b8@group.calendar.google.com'});
  context.sheet_=()=>({});context.calendar_=()=>({});
  context.LockService={getScriptLock:()=>({tryLock:()=>true,releaseLock:()=>{}})};
  context.PropertiesService={getScriptProperties:()=>props};
  context.Logger={log:()=>{}};
  const result=plain(run("bdReconcile_('calendar-delta')"));
  assert.equal(result.applied,true);
  assert.equal(values.get('BD_CAL_SYNC_TOKEN'),'new-token');
  assert.equal(values.get('BD_API_api-event'),key);
  // A conflict in one selected date must not commit a delta checkpoint.
  values.set('BD_CAL_SYNC_TOKEN','old-token');
  context.bdCalendarDays_=()=>({grouped:{[key]:[]},unsupported:[key+': all-day event']});
  const blocked=plain(run("bdReconcile_('calendar-delta')"));
  assert.equal(blocked.applied,false);
  assert.equal(values.get('BD_CAL_SYNC_TOKEN'),'old-token');
  assert.match(blocked.conflicts[0],/all-day/);
  Object.assign(context,original);
});
