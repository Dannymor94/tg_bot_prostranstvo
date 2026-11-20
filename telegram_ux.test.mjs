import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const files = ['Code.gs', 'TelegramUX.gs'];
const source = files.map(name => fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8'));

function setup() {
  const saved = new Map([
    ['CALENDAR_ID', 'test-calendar'], ['SPREADSHEET_ID', 'test-sheet'],
    ['SHEET_LABEL', 'Тест'], ['WRITE_ENABLED', 'true'],
    ['BIDIR_ACTIVE', 'true'], ['OWNER_CHAT_ID', '42'],
  ]);
  const props = {
    getProperty: key => saved.get(key) ?? null,
    setProperty: (key, value) => saved.set(key, String(value)),
    deleteProperty: key => saved.delete(key),
    getProperties: () => Object.fromEntries(saved),
  };
  const context = vm.createContext({
    Utilities: { formatDate: (d, _tz, format) => {
      const pad = n => String(n).padStart(2, '0');
      if (format === 'HH:mm') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      if (format === 'dd.MM HH:mm') return `${pad(d.getDate())}.${pad(d.getMonth()+1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    } },
    PropertiesService: { getScriptProperties: () => props },
    Session: { getScriptTimeZone: () => 'Europe/Moscow' },
    Logger: { log: () => {} },
  });
  source.forEach((code, index) => vm.runInContext(code, context, { filename: files[index] }));
  const run = expression => vm.runInContext(expression, context);
  context.config_ = () => ({calendarId: 'test-calendar', spreadsheetId: 'test-sheet',
    label: 'Тест', telegramToken: 'fake', ownerChatId: '42'});
  context.freeWindows_ = () => [[360, 720], [900, 1200]];
  context.checkAvailability_ = slot => ({ free: slot.from !== 930,
    busy: slot.from === 930 ? [[930, 990]] : [] });
  return { context, run, saved, props };
}

test('main menu offers small read-only actions and hides admin controls from ordinary users', () => {
  const { run } = setup();
  const a = run('tgUxMessage_("/start", 101)');
  const b = run('tgUxMessage_("/menu", 42)');
  assert.match(a.text, /без бронирования/i);
  assert.match(a.text, /перешли сюда сообщение/i);
  assert.equal(JSON.stringify(a.reply_markup).includes('u1|status'), false);
  assert.equal(JSON.stringify(b.reply_markup).includes('u1|status'), true);
});

test('date, duration, available slots and week are reachable without user state', () => {
  const { run } = setup();
  const today = run('tgUxToday_()');
  const dates = run(`tgUxCallback_('u1|dates|${today}', 100)`);
  assert.equal(dates.reply_markup.inline_keyboard.length >= 4, true);
  const day = run(`tgUxCallback_('u1|day|${today}', 100)`);
  assert.match(day.text, /На сколько времени/);
  const tomorrow = run(`tgUxAddDays_('${today}', 1)`);
  const page = run(`tgUxCallback_('u1|windows|${tomorrow}|90|evening|0', 100)`);
  assert.match(page.text, /Длительность: 90 мин/);
  const callbacks = page.reply_markup.inline_keyboard.flat().map(b => b.callback_data).filter(Boolean);
  assert.ok(callbacks.some(x => x.startsWith('u1|check|')));
  assert.ok(callbacks.every(x => Buffer.byteLength(x) <= 64));
  const week = run(`tgUxCallback_('u1|week|${today}', 100)`);
  assert.match(week.text, /Ближайшие 7 дней/);
});

test('forged, malformed, old and unrepresentable callback dates fail closed', () => {
  const { run } = setup();
  const today = run('tgUxToday_()');
  for (const data of ['u1|check|2025-01-01|900|60',
    'u1|check|2999-01-01|900|60', 'u1|check|2026-02-30|900|60',
    'u1|check|' + today + '|900|15',
    'u1|check|' + today + '|915|60',
    'u1|windows|' + today + '|60|all|-1',
    'u1|delete|' + today, 'u2|menu']) {
    const result = run(`tgUxCallback_(${JSON.stringify(data)}, 100)`);
    assert.match(result.text, /устарела|неверны/, data);
  }
});

test('text queries return a human-facing card, nearby alternatives and no guest names', () => {
  const { context, run } = setup();
  const day = run('tgUxAddDays_(tgUxToday_(), 1)');
  context.day = day;
  const busy = run(`tgUxResult_({date:day,from:930,to:990})`);
  assert.match(busy.text, /Время занято/);
  assert.match(busy.text, /Ближайшие свободные варианты/);
  assert.doesNotMatch(busy.text, /Тест|Марина|Дарья/);
  assert.ok(busy.reply_markup.inline_keyboard.some(row => row.some(btn => /🟢/.test(btn.text))));
  const free = run(`tgUxResult_({date:day,from:900,to:930})`);
  assert.match(free.text, /Время свободно/);
  assert.match(free.text, /не создаёт бронирование/);
  assert.ok(free.reply_markup.inline_keyboard.some(row => row.some(btn => /Перепроверить/.test(btn.text))));
});

test('free-slot list uses exact 30-minute steps, correct duration and avoids past today', () => {
  const { run } = setup();
  const tomorrow = run('tgUxAddDays_(tgUxToday_(), 1)');
  const starts = run(`tgUxCandidates_('${tomorrow}',90,'evening')`);
  assert.deepEqual(Array.from(starts), [1080,1110]);
  const mornings = run(`tgUxCandidates_('${tomorrow}',120,'morning')`);
  assert.ok(mornings.every(x => x < 720));
  const today = run('tgUxToday_()');
  const current = run('tgUxLocalNowMinutes_()');
  assert.ok(run(`tgUxCandidates_('${today}',30,'all')`).every(x => x >= current));
});

test('Telegram callback acknowledgement, edit and update offset complete end-to-end', () => {
  const { context, run, saved } = setup();
  const today = run('tgUxToday_()');
  const actions = [];
  context.telegramApi_ = (_token, method, payload) => {
    actions.push({method,payload});
    if (method === 'getUpdates') return [{update_id: 55,
      callback_query: {id:'c55', data:'u1|day|' + today,
        message: {message_id: 333,chat:{id:101}}}}];
    return true;
  };
  context.CacheService = {getScriptCache: () => ({get: () => null, put: () => {}})};
  context.LockService = {getUserLock: () => ({tryLock: () => true, releaseLock: () => {}})};
  run('pollTelegram()');
  const ack = actions.findIndex(x => x.method === 'answerCallbackQuery');
  const edited = actions.findIndex(x => x.method === 'editMessageText');
  assert.ok(ack >= 0 && edited > ack);
  assert.equal(actions[edited].payload.message_id, 333);
  assert.equal(saved.get('TG_OFFSET'), '56');
  assert.equal(saved.has('TG_OUTBOX_55'), false);
  assert.deepEqual(Array.from(actions.find(x => x.method === 'getUpdates').payload.allowed_updates),
    ['message','callback_query']);
});

test('forwarded text and /start produce readable Telegram messages with working buttons', () => {
  const { context, run, saved } = setup();
  const actions = [];
  context.telegramApi_ = (_token, method, payload) => {
    actions.push({method,payload});
    if (method === 'getUpdates') return [
      {update_id: 61, message: {chat:{id:101}, text:'/start'}},
      {update_id: 62, message: {chat:{id:101}, text:'завтра с 15 до 16'}},
    ];
    return true;
  };
  context.CacheService = {getScriptCache: () => {
    let count = 0;
    return {get: () => String(count), put: (_k,value) => {count=Number(value);}};
  }};
  context.LockService = {getUserLock: () => ({tryLock: () => true, releaseLock: () => {}})};
  run('pollTelegram()');
  const sent = actions.filter(x => x.method === 'sendMessage');
  assert.equal(sent.length, 2);
  assert.match(sent[0].payload.text, /Расписание аренды студии/);
  assert.ok(sent[0].payload.reply_markup.inline_keyboard.length >= 3);
  assert.match(sent[1].payload.text, /Время свободно/);
  assert.ok(sent[1].payload.reply_markup.inline_keyboard.some(row =>
    row.some(button => /Перепроверить/.test(button.text))));
  assert.equal(saved.get('TG_OFFSET'), '63');
});

test('callback edit retries transient errors using a durable outbox entry', () => {
  const { context, run, saved } = setup();
  saved.set('TG_OUTBOX_17',JSON.stringify({chatId:101,editMessageId:9,
    reply:'Новый экран',markup:{inline_keyboard:[]},attempts:0,nextAt:0}));
  let attempts = 0;
  context.telegramApi_ = (_token, method) => {
    if (method === 'editMessageText' && ++attempts === 1) throw Error('Telegram timeout');
    return true;
  };
  run('tgDeliverOutbox_({telegramToken:"test"},PropertiesService.getScriptProperties())');
  assert.equal(JSON.parse(saved.get('TG_OUTBOX_17')).attempts,1);
  const entry=JSON.parse(saved.get('TG_OUTBOX_17'));
  saved.set('TG_OUTBOX_17',JSON.stringify({...entry,nextAt:0}));
  run('tgDeliverOutbox_({telegramToken:"test"},PropertiesService.getScriptProperties())');
  assert.equal(saved.has('TG_OUTBOX_17'),false);
  assert.equal(attempts,2);
});

test('sync errors never show a slot as free, admin status is gated', () => {
  const { context, run, saved } = setup();
  const date = run('tgUxAddDays_(tgUxToday_(), 1)');
  context.checkAvailability_ = () => {throw Error('test sync conflict');};
  const blocked = run(`tgUxCallback_('u1|check|${date}|930|60', 101)`);
  assert.match(blocked.text, /не могу надёжно подтвердить/);
  assert.doesNotMatch(blocked.text, /Время свободно/);
  const outsider = run('tgUxCallback_("u1|status", 101)');
  assert.match(outsider.text, /только администратору/);
  saved.set('BD_PENDING_2026-11-22','yes');
  const admin = run('tgUxCallback_("u1|status", 42)');
  assert.match(admin.text, /Незавершённых операций: 1/);
});
