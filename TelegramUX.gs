/**
 * Lightweight, read-only Telegram rental UI. No database, web app or LLM.
 * All state is encoded in validated callback_data; the Calendar and Sheet
 * are checked live before claiming a slot is available.
 */
const TG_UX = Object.freeze({ version: 'u1', horizon: 120, pageSize: 8,
  durations: [30, 60, 90, 120], weekday: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] });

function tgUxButton_(label, data) { return { text: label, callback_data: data }; }
function tgUxReply_(text, rows) {
  return { text, reply_markup: { inline_keyboard: rows } };
}
function tgUxToday_() { return dayKey_(new Date()); }
function tgUxAddDays_(key, count) {
  const date = localDateFromKey_(key);
  date.setDate(date.getDate() + count);
  return dayKey_(date);
}
function tgUxValidDate_(key) {
  if (!/^20\d\d-\d\d-\d\d$/.test(String(key))) return false;
  const date = localDateFromKey_(key);
  if (dayKey_(date) !== key) return false;
  const today = tgUxToday_();
  return key >= today && key < tgUxAddDays_(today, TG_UX.horizon);
}
function tgUxDateLabel_(key) {
  const date = localDateFromKey_(key);
  return TG_UX.weekday[date.getDay()] + ', ' +
    String(date.getDate()).padStart(2, '0') + '.' +
    String(date.getMonth() + 1).padStart(2, '0');
}
function tgUxLocalNowMinutes_() {
  const time = Utilities.formatDate(new Date(), STUDIO.timezone, 'HH:mm');
  const match = /^(\d\d):(\d\d)$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}
function tgUxMonthDay_(key) { return tgUxDateLabel_(key) + '.' + key.slice(0, 4); }
function tgUxMainButton_() { return [tgUxButton_('🏠 Меню', 'u1|menu')]; }
function tgUxMenu_(chatId) {
  const rows = [
    [tgUxButton_('🟢 Подобрать свободное время', 'u1|dates|' + tgUxToday_())],
    [tgUxButton_('🗓 Расписание на неделю', 'u1|week|' + tgUxToday_())],
    [tgUxButton_('💬 Как проверить сообщением', 'u1|help')],
  ];
  const cfg = config_();
  if (cfg.ownerChatId && String(chatId) === String(cfg.ownerChatId)) {
    rows.push([tgUxButton_('⚙️ Состояние синхронизации', 'u1|status')]);
  }
  // Optional owner-approved public free/busy view. Never expose a calendar's
  // internal ID or assume that its details are safe for publication.
  const link = PropertiesService.getScriptProperties().getProperty('PUBLIC_CALENDAR_URL');
  if (link && /^https:\/\/calendar\.google\.com\//.test(link)) {
    rows.push([{ text: '📆 Открыть общий календарь', url: link }]);
  }
  return tgUxReply_(
    '🏠 Расписание аренды студии\n\n' +
    'Выбери дату и длительность — покажу свободные варианты.\n' +
    'Или перешли сюда сообщение, например: «23 ноября с 15:30 до 17:00».\n\n' +
    'Все проверки без бронирования. Время — московское.', rows);
}
function tgUxHelp_() {
  return tgUxReply_('💬 Просто отправь или перешли сообщение с временем:\n' +
    '«23 ноября с 15:30 до 17:00»\n' +
    '«Завтра с 18 до 19:30»\n' +
    '«/free 23 ноября» — все свободные окна\n\n' +
    'Можно выбрать дату кнопками. Бот проверяет, но не бронирует.',
    [[tgUxButton_('🟢 Выбрать дату', 'u1|dates|' + tgUxToday_())], tgUxMainButton_()]);
}
function tgUxDates_(first) {
  const today = tgUxToday_();
  if (!tgUxValidDate_(first)) first = today;
  const rows = [];
  for (let i = 0; i < 7; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, 7); j++) {
      const key = tgUxAddDays_(first, j);
      if (tgUxValidDate_(key)) row.push(tgUxButton_(tgUxDateLabel_(key), 'u1|day|' + key));
    }
    if (row.length) rows.push(row);
  }
  const page = [];
  if (first > today) page.push(tgUxButton_('◀ Назад', 'u1|dates|' +
    (tgUxAddDays_(first, -7) < today ? today : tgUxAddDays_(first, -7))));
  if (tgUxValidDate_(tgUxAddDays_(first, 7))) {
    page.push(tgUxButton_('Дальше ▶', 'u1|dates|' + tgUxAddDays_(first, 7)));
  }
  if (page.length) rows.push(page);
  rows.push(tgUxMainButton_());
  return tgUxReply_('🗓 Выбери дату аренды\nВремя — московское.', rows);
}
function tgUxDay_(date) {
  if (!tgUxValidDate_(date)) return tgUxExpired_();
  return tgUxReply_('📅 ' + tgUxMonthDay_(date) + '\n\n' +
    'На сколько времени нужна студия?', [
    [tgUxButton_('30 минут', 'u1|windows|' + date + '|30|all|0'),
      tgUxButton_('1 час', 'u1|windows|' + date + '|60|all|0')],
    [tgUxButton_('1,5 часа', 'u1|windows|' + date + '|90|all|0'),
      tgUxButton_('2 часа', 'u1|windows|' + date + '|120|all|0')],
    [tgUxButton_('◀ Другая дата', 'u1|dates|' + date)], tgUxMainButton_(),
  ]);
}
function tgUxCandidates_(date, duration, part) {
  const windows = freeWindows_(date, config_());
  const candidates = [];
  const earliest = date === tgUxToday_() ? tgUxLocalNowMinutes_() : 0;
  const limits = { all: [360, 1320], morning: [360, 720],
    day: [720, 1080], evening: [1080, 1320] };
  const [minimum, maximum] = limits[part];
  for (const [a, b] of windows) {
    for (let start = Math.ceil(a / 30) * 30; start + duration <= b; start += 30) {
      if (start >= earliest && start >= minimum && start < maximum) candidates.push(start);
    }
  }
  return candidates;
}
function tgUxRemainingWindows_(date, windows) {
  if (date !== tgUxToday_()) return windows;
  const nextStart = Math.ceil(tgUxLocalNowMinutes_() / 30) * 30;
  return windows.map(([a, b]) => [Math.max(a, nextStart), b]).filter(([a, b]) => a < b);
}
function tgUxWindows_(date, duration, part, page) {
  if (!tgUxValidDate_(date)) return tgUxExpired_();
  if (!TG_UX.durations.includes(duration) || !['all', 'morning', 'day', 'evening'].includes(part) ||
      !Number.isInteger(page) || page < 0 || page > 30) return tgUxExpired_();
  const starts = tgUxCandidates_(date, duration, part);
  const totalPages = Math.max(1, Math.ceil(starts.length / TG_UX.pageSize));
  const current = Math.min(page, totalPages - 1);
  const slice = starts.slice(current * TG_UX.pageSize, (current + 1) * TG_UX.pageSize);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map(start => tgUxButton_(
      formatStudioTime_(start) + '–' + formatStudioTime_(start + duration),
      'u1|check|' + date + '|' + start + '|' + duration)));
  }
  rows.push([
    tgUxButton_('Все', 'u1|windows|' + date + '|' + duration + '|all|0'),
    tgUxButton_('Утро', 'u1|windows|' + date + '|' + duration + '|morning|0'),
    tgUxButton_('День', 'u1|windows|' + date + '|' + duration + '|day|0'),
    tgUxButton_('Вечер', 'u1|windows|' + date + '|' + duration + '|evening|0'),
  ]);
  const nav = [];
  if (current > 0) nav.push(tgUxButton_('◀', 'u1|windows|' + date + '|' + duration + '|' + part + '|' + (current - 1)));
  if (current + 1 < totalPages) nav.push(tgUxButton_('▶', 'u1|windows|' + date + '|' + duration + '|' + part + '|' + (current + 1)));
  if (nav.length) rows.push(nav);
  rows.push([tgUxButton_('◀ Длительность', 'u1|day|' + date),
    tgUxButton_('📅 Дата', 'u1|dates|' + date)]);
  rows.push(tgUxMainButton_());
  return tgUxReply_('🟢 ' + tgUxMonthDay_(date) + '\n' +
    'Длительность: ' + duration + ' мин.\n' +
    (starts.length ? 'Свободные варианты (' + starts.length + '), страница ' +
      (current + 1) + '/' + totalPages + ':' : 'Подходящих свободных окон нет. Попробуй другую длительность или дату.'),
    rows);
}
function tgUxWeek_(first) {
  if (!tgUxValidDate_(first)) first = tgUxToday_();
  const rows = [];
  const lines = ['🗓 Ближайшие 7 дней — краткий обзор',
    'Свободные окна от 1 часа (московское время):', ''];
  for (let i = 0; i < 7; i++) {
    const key = tgUxAddDays_(first, i);
    if (!tgUxValidDate_(key)) break;
    try {
      const starts = tgUxCandidates_(key, 60, 'all');
      lines.push(tgUxDateLabel_(key) + ': ' +
        (starts.length ? '🟢 ' + formatStudioTime_(starts[0]) + ' и ещё ' +
          (starts.length - 1) + ' вариантов' : '🔴 свободных окон нет'));
    } catch (_error) {
      lines.push(tgUxDateLabel_(key) + ': ⚠️ данные не подтверждены');
    }
    rows.push([tgUxButton_('📅 ' + tgUxDateLabel_(key), 'u1|day|' + key)]);
  }
  const next = tgUxAddDays_(first, 7);
  if (tgUxValidDate_(next)) rows.push([tgUxButton_('Следующая неделя ▶', 'u1|week|' + next)]);
  if (first > tgUxToday_()) rows.push([tgUxButton_('◀ Предыдущая неделя', 'u1|week|' +
    (tgUxAddDays_(first, -7) < tgUxToday_() ? tgUxToday_() : tgUxAddDays_(first, -7)))]);
  rows.push(tgUxMainButton_());
  return tgUxReply_(lines.join('\n') + '\n\nВыбери день для точного времени.', rows);
}
function tgUxResult_(slot) {
  if (!tgUxValidDate_(slot.date) || !Number.isInteger(slot.from) ||
      !Number.isInteger(slot.to) || slot.from < 360 || slot.to > 1320 ||
      slot.to <= slot.from) return tgUxExpired_();
  if (slot.date === tgUxToday_() && slot.from < tgUxLocalNowMinutes_()) {
    return tgUxReply_('⏳ Это время сегодня уже прошло. Выбери ближайшее доступное окно.',
      [[tgUxButton_('🟢 Свободные окна', 'u1|windows|' + slot.date + '|60|all|0')],
        tgUxMainButton_()]);
  }
  const result = checkAvailability_(slot, config_());
  const range = formatStudioTime_(slot.from) + '–' + formatStudioTime_(slot.to);
  const duration = slot.to - slot.from;
  const rows = [[tgUxButton_('🔄 Перепроверить', 'u1|check|' + slot.date + '|' + slot.from + '|' + duration)]];
  let text = (result.free ? '✅ Время свободно' : '❌ Время занято') + '\n' +
    tgUxMonthDay_(slot.date) + ', ' + range + '\n' +
    'Длительность: ' + duration + ' мин.\nПроверено сейчас (МСК).';
  if (!result.free) {
    const nearest = tgUxCandidates_(slot.date, duration, 'all')
      .sort((a, b) => Math.abs(a - slot.from) - Math.abs(b - slot.from) || a - b).slice(0, 3);
    text += '\n\nБлижайшие свободные варианты:';
    if (!nearest.length) text += '\nНа эту дату подходящих нет.';
    for (const start of nearest) rows.push([tgUxButton_(
      '🟢 ' + formatStudioTime_(start) + '–' + formatStudioTime_(start + duration),
      'u1|check|' + slot.date + '|' + start + '|' + duration)]);
  }
  rows.push([tgUxButton_('Другие окна', 'u1|windows|' + slot.date + '|' +
    (TG_UX.durations.includes(duration) ? duration : 60) + '|all|0'),
    tgUxButton_('Другая дата', 'u1|dates|' + slot.date)]);
  rows.push(tgUxMainButton_());
  return tgUxReply_(text + '\n\nБот не создаёт бронирование.', rows);
}
function tgUxStatus_(chatId) {
  const cfg = config_();
  if (!cfg.ownerChatId || String(chatId) !== String(cfg.ownerChatId)) {
    return tgUxReply_('🔒 Состояние синхронизации доступно только администратору.', [tgUxMainButton_()]);
  }
  const props = PropertiesService.getScriptProperties().getProperties();
  let status;
  try { status = JSON.parse(props.BD_LAST_SYNC || 'null'); } catch (_error) { status = null; }
  const pending = Object.keys(props).filter(key => key.startsWith('BD_PENDING_')).length;
  const stamp = status && status.at ? Utilities.formatDate(new Date(status.at), STUDIO.timezone, 'dd.MM HH:mm') : 'нет данных';
  const tooOld = !status || !status.at ||
    !Number.isFinite(new Date(status.at).getTime()) ||
    Date.now() - new Date(status.at).getTime() > 30 * 60000;
  const lines = ['⚙️ Состояние расписания',
    'Синхронизация: ' + (props.BIDIR_PAUSED === 'true' ? '⏸ пауза' : props.BIDIR_ACTIVE === 'true' ? '🟢 включена' : '⚠️ неактивна'),
    'Последняя сверка: ' + stamp + ' МСК',
    'Актуальность сверки: ' + (tooOld ? '⚠️ более 30 минут / нет данных' : 'недавно'),
    'Конфликтов: ' + (status ? status.conflicts : 'нет данных'),
    'Незавершённых операций: ' + pending,
    'Точный Calendar API: ' + (props.BD_CAL_SYNC_TOKEN ? 'токен получен' : 'токен ещё не получен'),
    'Ошибок доставки Telegram: ' + (props.TG_FAILED_COUNT || '0')];
  return tgUxReply_(lines.join('\n'), [[tgUxButton_('🔄 Обновить', 'u1|status')], tgUxMainButton_()]);
}
function tgUxExpired_() {
  return tgUxReply_('⚠️ Кнопка устарела или данные неверны. Выбери дату заново.',
    [[tgUxButton_('📅 Выбрать дату', 'u1|dates|' + tgUxToday_())], tgUxMainButton_()]);
}
function tgUxFailure_() {
  return tgUxReply_('⚠️ Сейчас не могу надёжно подтвердить свободное время. Попробуй ещё раз чуть позже.',
    [[tgUxButton_('📅 Выбрать дату', 'u1|dates|' + tgUxToday_())], tgUxMainButton_()]);
}
function tgUxCallback_(data, chatId) {
  const input = String(data || '');
  if (input.length > 64) return tgUxExpired_();
  const v = input.split('|');
  if (v[0] !== TG_UX.version) return tgUxExpired_();
  const number = s => /^\d{1,4}$/.test(String(s)) ? Number(s) : NaN;
  try {
    if (v.length === 2 && v[1] === 'menu') return tgUxMenu_(chatId);
    if (v.length === 2 && v[1] === 'help') return tgUxHelp_();
    if (v.length === 2 && v[1] === 'status') return tgUxStatus_(chatId);
    if (v.length === 3 && v[1] === 'dates') return tgUxDates_(v[2]);
    if (v.length === 3 && v[1] === 'day') return tgUxDay_(v[2]);
    if (v.length === 3 && v[1] === 'week') return tgUxWeek_(v[2]);
    if (v.length === 6 && v[1] === 'windows') {
      return tgUxWindows_(v[2], number(v[3]), v[4], number(v[5]));
    }
    if (v.length === 5 && v[1] === 'check' &&
        number(v[3]) % 30 === 0 && TG_UX.durations.includes(number(v[4]))) {
      return tgUxResult_({ date: v[2], from: number(v[3]), to: number(v[3]) + number(v[4]) });
    }
  } catch (error) {
    Logger.log('Telegram UX check unavailable: ' + String(error.message));
    return tgUxFailure_();
  }
  return tgUxExpired_();
}
function tgUxMessage_(message, chatId) {
  const input = String(message || '').trim();
  if (/^\/(?:start|menu|help)(?:@\w+)?(?:\s|$)/i.test(input) || /^помощь\s*$/i.test(input)) {
    return tgUxMenu_(chatId);
  }
  if (/^\/week(?:@\w+)?(?:\s|$)/i.test(input)) return tgUxWeek_(tgUxToday_());
  if (/^\/status(?:@\w+)?(?:\s|$)/i.test(input)) return tgUxStatus_(chatId);
  if (/^\/free(?:@\w+)?(?:\s|$)/i.test(input)) {
    const request = input.replace(/^\/free(?:@\w+)?\s*/i, '').trim();
    const day = parseRussianSlot_(request + ' с 06:00 до 22:00', new Date());
    if (day.error) return tgUxReply_(day.error, [[tgUxButton_('📅 Выбрать дату',
      'u1|dates|' + tgUxToday_())], tgUxMainButton_()]);
    try {
      const windows = tgUxRemainingWindows_(day.date, freeWindows_(day.date, config_()));
      return tgUxReply_('🗓 Свободные окна ' + tgUxMonthDay_(day.date) + ':\n' +
        (windows.length ? windows.map(w => formatStudioTime_(w[0]) + '–' + formatStudioTime_(w[1])).join('\n') : 'Свободных окон нет.'),
        [[tgUxButton_('30 мин', 'u1|windows|' + day.date + '|30|all|0'),
          tgUxButton_('1 час', 'u1|windows|' + day.date + '|60|all|0'),
          tgUxButton_('1,5 часа', 'u1|windows|' + day.date + '|90|all|0')], tgUxMainButton_()]);
    } catch (error) { Logger.log('Telegram /free unavailable: ' + String(error.message)); return tgUxFailure_(); }
  }
  const clauses = input.split(/[;\n]+/).map(x => x.trim()).filter(Boolean);
  if (clauses.length > 1) {
    return tgUxReply_(answerTelegram_(input, chatId), [tgUxMainButton_()]);
  }
  const slot = parseRussianSlot_(input, new Date());
  if (slot.error) return tgUxReply_(slot.error + '\n\nМожно выбрать дату и время кнопками.',
    [[tgUxButton_('📅 Выбрать дату', 'u1|dates|' + tgUxToday_())], tgUxMainButton_()]);
  try { return tgUxResult_(slot); }
  catch (error) { Logger.log('Telegram text check unavailable: ' + String(error.message)); return tgUxFailure_(); }
}

/** Safe GAS editor preflight: no Telegram messages, Calendar or Sheet writes. */
function tgUxPreflight() {
  const cfg = config_();
  const menu = tgUxMenu_(cfg.ownerChatId || '');
  const today = tgUxToday_();
  const day = tgUxCallback_('u1|day|' + today, cfg.ownerChatId || '');
  if (!menu.reply_markup?.inline_keyboard?.length ||
      !day.reply_markup?.inline_keyboard?.length) throw Error('Telegram UX menu is unavailable');
  Logger.log(JSON.stringify({ ready: true, date: today,
    menuActions: menu.reply_markup.inline_keyboard.length,
    durationActions: day.reply_markup.inline_keyboard.length }));
  return 'Telegram UX read-only preflight passed';
}
