import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('./Code.gs', import.meta.url), 'utf8');
new vm.Script(code, { filename: 'Code.gs' });
const ctx = vm.createContext({
  Utilities: { formatDate: d => {
    const y = d.getFullYear();
    return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  } },
});
vm.runInContext(code, ctx);
const exec = (expr) => vm.runInContext(expr, ctx);

test('15:30–16:30 projects +30 in first hour and normal label in next', () => {
  const result = exec(`projectEvents_([{id:'a',start:new Date(2026,10,22,15,30),
    end:new Date(2026,10,22,16,30), allDay:false}], 'Даниил', ['2026-11-22'])`);
  assert.equal(result.desired['2026-11-22:15'].value, '(+30) Даниил');
  assert.equal(result.desired['2026-11-22:16'].value, 'Даниил');
  assert.equal(result.warnings.length, 1);
});

test('15:00 starts with name alone; 15:30 starts with (+30) before name in the same hour', () => {
  const result = exec(`projectEvents_([
    {id:'full',start:new Date(2026,10,22,15),end:new Date(2026,10,22,16),allDay:false},
    {id:'half',start:new Date(2026,10,23,15,30),end:new Date(2026,10,23,16),allDay:false}
  ], 'Свободное имя', ['2026-11-22','2026-11-23'])`);
  assert.equal(result.desired['2026-11-22:15'].value, 'Свободное имя');
  assert.equal(result.desired['2026-11-23:15'].value, '(+30) Свободное имя');
});

test('moving an event deletes its old owned cells and creates the new one', () => {
  const row = Array(16).fill(''); row[9] = '(+30) Даниил'; row[10] = 'Даниил';
  ctx.inputRow = row;
  const result = exec(`planRow_('2026-11-22', inputRow,
    {'15':'(+30) Даниил','16':'Даниил'},
    {'2026-11-22:17':{value:'Даниил',ids:['a']}})`);
  assert.deepEqual(JSON.parse(JSON.stringify(result.actions.map(x => [x.hour, x.kind]).sort())),
    [[15,'delete'],[16,'delete'],[17,'create']]);
});

test('deleting calendar event clears all unchanged owned cells', () => {
  const row = Array(16).fill(''); row[9] = 'Даниил';
  ctx.inputRow = row;
  const result = exec(`planRow_('2026-11-22', inputRow, {'15':'Даниил'}, {})`);
  assert.equal(result.actions[0].kind, 'delete');
  assert.equal(result.actions[0].to, '');
});

test('manual changes never get overwritten by calendar', () => {
  const row = Array(16).fill(''); row[9] = 'Ольга';
  ctx.inputRow = row;
  const result = exec(`planRow_('2026-11-22', inputRow, {'15':'Даниил'},
    {'2026-11-22:15':{value:'Даниил',ids:['a']}})`);
  assert.equal(result.actions.length, 0);
  assert.equal(result.conflicts.length, 1);
});

test('existing foreign booking is a conflict, not an overwrite', () => {
  const row = Array(16).fill(''); row[9] = 'Наталья';
  ctx.inputRow = row;
  const result = exec(`planRow_('2026-11-22', inputRow, {},
    {'2026-11-22:15':{value:'Даниил',ids:['a']}})`);
  assert.equal(result.actions.length, 0);
  assert.equal(result.conflicts.length, 1);
});

test('repeated sync of unchanged calendar is idempotent', () => {
  const row = Array(16).fill(''); row[9] = 'Даниил';
  ctx.inputRow = row;
  const result = exec(`planRow_('2026-11-22', inputRow, {'15':'Даниил'},
    {'2026-11-22:15':{value:'Даниил',ids:['a']}})`);
  assert.equal(result.actions.length, 0);
  assert.equal(result.conflicts.length, 0);
});

test('two events in one sheet hour fail closed', () => {
  const result = exec(`projectEvents_([
    {id:'a',start:new Date(2026,10,22,15,0),end:new Date(2026,10,22,15,30),allDay:false},
    {id:'b',start:new Date(2026,10,22,15,30),end:new Date(2026,10,22,16,0),allDay:false}
  ], 'Даниил', ['2026-11-22'])`);
  assert.equal(result.desired['2026-11-22:15'].collision, true);
});

test('dates and time phrases are parsed without LLM', () => {
  const examples = [
    ['22 ноября с 15:30 до 17:00','2026-11-22',930,1020],
    ['22.11 с 14-16','2026-11-22',840,960],
    ['в субботу с 14 до 16','2026-11-21',840,960],
    ['завтра с 18 до 19:30','2026-11-20',1080,1170],
    ['послезавтра с 9 до 10','2026-11-21',540,600],
    ['25-го с 15 до 17','2026-11-25',900,1020],
    ['в сб с 9 до 10','2026-11-21',540,600],
  ];
  for (const [phrase, date, from, to] of examples) {
    ctx.phrase = phrase;
    const parsed = exec('parseRussianSlot_(phrase, new Date(2026,10,19,12))');
    assert.equal(parsed.date, date, phrase + ' → ' + JSON.stringify(parsed));
    assert.equal(parsed.from, from, phrase);
    assert.equal(parsed.to, to, phrase);
  }
});

test('ambiguous requests are rejected', () => {
  for (const phrase of ['22 и 23 ноября с 12 до 15','в субботу вечером',
    '22 ноября с 18 до 17', 'с 14 до 16']) {
    ctx.phrase = phrase;
    const parsed = exec('parseRussianSlot_(phrase, new Date(2026,10,19,12))');
    assert.equal(typeof parsed.error, 'string', phrase);
  }
});

test('half-hour legacy cells block only the latter half of an hour', () => {
  assert.equal(exec('overlaps_(900, 930, 930, 960)'), false);
  assert.equal(exec('overlaps_(930, 945, 930, 960)'), true);
});

test('Telegram /start, /help and помощь explain required date and time', () => {
  for (const command of ['/start', '/help', 'помощь']) {
    ctx.command = command;
    const response = exec('answerTelegram_(command)');
    assert.match(response, /22 ноября с 15:30 до 17:00/);
    assert.match(response, /бронирование не создаю/);
  }
});

test('full sync creates, moves and deletes owned cells without touching others', () => {
  const now = exec('new Date()');
  const today = vm.runInContext('new Date(new Date().getFullYear(),new Date().getMonth(),new Date().getDate())', ctx);
  const cells = Array(16).fill('');
  cells[10] = 'Ольга'; // another teacher's booking at 16:00
  const storage = new Map([
    ['CALENDAR_ID','studio-test'], ['SHEET_LABEL','Даниил'],
    ['WRITE_ENABLED','true'], ['SYNC_DAYS','1'],
  ]);
  const props = {
    getProperty: k => storage.get(k) || null,
    setProperty: (k,v) => storage.set(k,String(v)),
    deleteProperty: k => storage.delete(k),
    getProperties: () => Object.fromEntries(storage),
  };
  let rejectWrite = false;
  const getRange = (row, col, height, width) => {
    if (row === 2 && col === 2) return {
      getDisplayValues: () => [Array.from({length:16},(_,i) => `${i + 6}:00-${i + 7}:00`)],
    };
    if (row === 6 && col === 1) return { getValues: () => [[today]] };
    if (row === 6 && col === 2 && height === 1 && width === 16) return {
      getDisplayValues: () => [cells.slice()],
      getDataValidations: () => {throw Error('Dropdown must be ignored');},
    };
    if (row === 6 && col >= 2 && col <= 17) return {
      getDisplayValue: () => cells[col - 2],
      setValue: value => { if (rejectWrite) throw Error('validation rejected'); cells[col - 2] = value; },
    };
    throw Error('Unexpected range: ' + [row,col,height,width]);
  };
  const fakeSheet = { getRange, getLastRow: () => 6 };
  let events = [];
  const makeEvent = (hour) => ({
    getId: () => 'calendar-event-A',
    getStartTime: () => new Date(today.getFullYear(),today.getMonth(),today.getDate(),hour),
    getEndTime: () => new Date(today.getFullYear(),today.getMonth(),today.getDate(),hour + 1),
    isAllDayEvent: () => false,
  });
  ctx.PropertiesService = {getScriptProperties: () => props};
  ctx.Session = { getScriptTimeZone: () => 'Europe/Moscow' };
  ctx.CalendarApp = {getCalendarById: () => ({getEvents: () => events})};
  ctx.SpreadsheetApp = {openById: () => ({
    getSpreadsheetTimeZone: () => 'Europe/Moscow',
    getSheetByName: () => fakeSheet,
  }),flush: () => {}};
  ctx.LockService = { getScriptLock: () => ({tryLock: () => true,releaseLock: () => {}}) };
  ctx.Logger = { log: () => {} };
  events = [makeEvent(15)];
  ctx.syncCalendarToSheet();
  assert.equal(cells[9], 'Даниил');
  assert.equal(cells[10], 'Ольга');
  events = [makeEvent(17)];
  ctx.syncCalendarToSheet();
  assert.equal(cells[9], '');
  assert.equal(cells[10], 'Ольга');
  assert.equal(cells[11], 'Даниил');
  events = [];
  ctx.syncCalendarToSheet();
  assert.equal(cells[11], '');
  assert.equal(cells[10], 'Ольга');
  assert.equal(storage.get('OWN_' + exec('dayKey_(new Date())')), undefined);
  rejectWrite = true;
  events = [makeEvent(18)];
  const rejected = ctx.syncCalendarToSheet();
  assert.equal(cells[12], '');
  assert.match(rejected.conflicts.join('\n'), /validation rejected/);
  assert.equal(Object.keys(props.getProperties()).filter(x => x.startsWith('PENDING_')).length, 0);
  rejectWrite = false;
  ctx.syncCalendarToSheet();
  assert.equal(cells[12], 'Даниил');
});
