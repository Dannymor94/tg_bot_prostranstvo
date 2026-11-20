/**
 * Studio booking bridge — Google Apps Script / V8.
 *
 * Source of truth for YOUR bookings: a dedicated Google Calendar.
 * Other teachers' bookings: existing Google Sheet "Бронирование".
 *
 * REQUIRED Script Properties (Project settings → Script properties):
 *   CALENDAR_ID        ID of dedicated calendar (NOT a personal calendar)
 *   SPREADSHEET_ID     Target spreadsheet ID: use the TEST COPY first
 *   SHEET_LABEL        Any text for your booking, e.g. "Даниил"
 *   TELEGRAM_TOKEN     Token from @BotFather
 *   WRITE_ENABLED      "false" until dry-run approved, then "true"
 * OPTIONAL:
 *   OWNER_CHAT_ID      Telegram chat ID for changed-conflict alerts
 *   SYNC_DAYS          60 by default; 1..120
 *
 * Script project timezone must be Europe/Moscow.
 * Only the sheet tab name is fixed. The spreadsheet ID is required explicitly.
 */

const STUDIO = Object.freeze({
  sheetName: 'Бронирование',
  timezone: 'Europe/Moscow',
  firstDataRow: 6,
  firstHour: 6,
  lastHour: 22, // exclusive; sheet columns B:Q
  prefix: 'OWN_',
});

function config_() {
  const p = PropertiesService.getScriptProperties();
  const c = {
    calendarId: p.getProperty('CALENDAR_ID'),
    spreadsheetId: p.getProperty('SPREADSHEET_ID'),
    label: p.getProperty('SHEET_LABEL'),
    telegramToken: p.getProperty('TELEGRAM_TOKEN'),
    ownerChatId: p.getProperty('OWNER_CHAT_ID') || '',
    writeEnabled: p.getProperty('WRITE_ENABLED') === 'true',
    syncDays: Number(p.getProperty('SYNC_DAYS') || 60),
  };
  if (!c.calendarId) throw Error('Set CALENDAR_ID in Script properties');
  if (!c.spreadsheetId) throw Error('Set SPREADSHEET_ID (test copy first) in Script properties');
  if (!c.label) throw Error('Set SHEET_LABEL in Script properties');
  if (!Number.isInteger(c.syncDays) || c.syncDays < 1 || c.syncDays > 120) {
    throw Error('SYNC_DAYS must be 1..120');
  }
  if (Session.getScriptTimeZone() !== STUDIO.timezone) {
    throw Error('Set script timezone to Europe/Moscow');
  }
  return c;
}

function calendar_(cfg) {
  const cal = CalendarApp.getCalendarById(cfg.calendarId);
  if (!cal) throw Error('No access to CALENDAR_ID');
  return cal;
}

function sheet_(cfg) {
  const ss = SpreadsheetApp.openById(cfg.spreadsheetId);
  if (ss.getSpreadsheetTimeZone() !== STUDIO.timezone) {
    throw Error('Spreadsheet timezone changed; expected Europe/Moscow');
  }
  const s = ss.getSheetByName(STUDIO.sheetName);
  if (!s) throw Error('Sheet "Бронирование" was not found');
  // Verified against the native Sheet: hour headings are on row 1.
  const headers = s.getRange(1, 2, 1, 16).getDisplayValues()[0];
  headers.forEach((x, i) => {
    const actual = Number(String(x).trim().match(/^(\d{1,2}):00\s*-/)?.[1]);
    if (actual !== i + STUDIO.firstHour) {
      throw Error('Unexpected hour in ' + colName_(i + 2) + '1: ' + x);
    }
  });
  return s;
}

function colName_(column) {
  let out = '';
  while (column) { out = String.fromCharCode(65 + (column - 1) % 26) + out; column = Math.floor((column - 1) / 26); }
  return out;
}

function dayKey_(date) {
  return Utilities.formatDate(date, STUDIO.timezone, 'yyyy-MM-dd');
}

function localDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function localDateFromKey_(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dateRows_(sheet, keys) {
  // Read only column A; never scan/write the financial-model tabs.
  const values = sheet.getRange(STUDIO.firstDataRow, 1,
    sheet.getLastRow() - STUDIO.firstDataRow + 1, 1).getValues();
  const wanted = new Set(keys);
  const rows = {};
  values.forEach((r, index) => {
    if (!(r[0] instanceof Date)) return;
    const key = dayKey_(r[0]);
    if (!wanted.has(key)) return;
    if (rows[key]) throw Error('Duplicate date in sheet: ' + key);
    rows[key] = STUDIO.firstDataRow + index;
  });
  return rows;
}

/** Pure helper: one event can cover multiple hourly sheet columns. */
function projectEvents_(items, label, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const desired = {};
  const warnings = [];
  items.forEach(item => {
    const id = String(item.id);
    const start = new Date(item.start);
    const end = new Date(item.end);
    if (item.allDay) { warnings.push(id + ': all-day event omitted'); return; }
    if (!(start < end)) { warnings.push(id + ': invalid duration'); return; }
    if (![0, 30].includes(start.getMinutes()) || ![0, 30].includes(end.getMinutes()) ||
        start.getSeconds() !== 0 || end.getSeconds() !== 0) {
      warnings.push(id + ': minutes must be 00 or 30; event omitted from sheet'); return;
    }
    if (end.getMinutes() === 30) {
      warnings.push(id + ': end at :30 is displayed conservatively as a full final hour');
    }
    for (let day = localDay_(start); day < end; day.setDate(day.getDate() + 1)) {
      const key = dayKey_(day);
      if (!allowed.has(key)) continue;
      for (let h = STUDIO.firstHour; h < STUDIO.lastHour; h++) {
        const a = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h);
        const b = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h + 1);
        if (!(start < b && end > a)) continue;
        const cellKey = key + ':' + h;
        const startedAtHalf = start >= a && start < b && start.getMinutes() === 30;
        const value = (startedAtHalf ? '(+30) ' : '') + label;
        if (!desired[cellKey]) desired[cellKey] = { value, ids: [id] };
        else { desired[cellKey].ids.push(id); desired[cellKey].collision = true; }
      }
    }
  });
  return { desired, warnings };
}

function ledger_(properties, key) {
  const value = properties.getProperty(STUDIO.prefix + key);
  return value ? JSON.parse(value) : {};
}

function saveLedger_(properties, key, ledger) {
  const name = STUDIO.prefix + key;
  if (Object.keys(ledger).length) properties.setProperty(name, JSON.stringify(ledger));
  else properties.deleteProperty(name);
}

/** The planner is pure: no writes. Owned cells can be edited/deleted if unchanged. */
function planRow_(key, displayed, owned, desired) {
  const actions = [];
  const conflicts = [];
  for (let hour = STUDIO.firstHour; hour < STUDIO.lastHour; hour++) {
    const i = hour - STUDIO.firstHour;
    const current = String(displayed[i] == null ? '' : displayed[i]);
    const prior = owned[String(hour)];
    const target = desired[key + ':' + hour];
    const ref = key + ' ' + String(hour).padStart(2, '0') + ':00';
    if (target && target.collision) {
      conflicts.push(ref + ' (multiple calendar events in one sheet cell)');
      continue;
    }
    if (prior && current !== prior) {
      conflicts.push(ref + ' (manually changed since last sync)');
      continue;
    }
    if (!target && prior) actions.push({ hour, from: current, to: '', kind: 'delete' });
    else if (target && prior && current !== target.value) {
      actions.push({ hour, from: current, to: target.value, kind: 'replace' });
    } else if (target && !prior) {
      if (current === '') actions.push({ hour, from: '', to: target.value, kind: 'create' });
      else conflicts.push(ref + ' (existing reservation; never overwrite without ownership)');
    }
  }
  return { actions, conflicts };
}

function eventItems_(calendar, from, to) {
  return calendar.getEvents(from, to).map((e, i) => ({
    id: e.getId() + '#' + i, // occurrence-distinct within this bounded query
    start: e.getStartTime(),
    end: e.getEndTime(),
    allDay: e.isAllDayEvent(),
  }));
}

/**
 * Safe by default: writes only when WRITE_ENABLED=true.
 * Calendar edit/move/delete propagates to previously owned cells.
 */
function syncCalendarToSheet() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw Error('Sync already running');
  try {
    const cfg = config_();
    const calendar = calendar_(cfg);
    const sheet = sheet_(cfg);
    const props = PropertiesService.getScriptProperties();
    const incomplete = Object.keys(props.getProperties()).filter(x => x.startsWith('PENDING_'));
    if (incomplete.length) {
      throw Error('Pending cell transaction requires manual review: ' + incomplete.join(', '));
    }
    const today = localDay_(new Date());
    const keys = Array.from({ length: cfg.syncDays }, (_, n) => {
      const d = new Date(today); d.setDate(d.getDate() + n); return dayKey_(d);
    });
    const end = new Date(today); end.setDate(end.getDate() + cfg.syncDays);
    const rows = dateRows_(sheet, keys);
    const { desired, warnings } = projectEvents_(eventItems_(calendar, today, end), cfg.label, keys);
    const report = { dryRun: !cfg.writeEnabled, changes: [], conflicts: [], warnings };
    keys.forEach(key => {
      const hasPlan = Object.keys(desired).some(x => x.startsWith(key + ':'));
      const owned = ledger_(props, key);
      if (!hasPlan && !Object.keys(owned).length) return;
      if (!rows[key]) { report.conflicts.push(key + ' (date absent from sheet)'); return; }
      const row = rows[key];
      const range = sheet.getRange(row, 2, 1, 16);
      const display = range.getDisplayValues()[0];
      const plan = planRow_(key, display, owned, desired);
      report.conflicts.push(...plan.conflicts);
      plan.actions.forEach(action => {
        const a1 = colName_(action.hour - STUDIO.firstHour + 2) + row;
        report.changes.push({ cell: a1, from: action.from, to: action.to, kind: action.kind });
        if (!cfg.writeEnabled) return;
        const cell = sheet.getRange(row, action.hour - STUDIO.firstHour + 2);
        if (String(cell.getDisplayValue()) !== action.from) {
          report.conflicts.push(a1 + ' (concurrent manual edit)');
          return;
        }
        // Pending journal survives a crash between the cell write and ledger update.
        const pendingKey = 'PENDING_' + key + '_' + action.hour;
        props.setProperty(pendingKey, JSON.stringify({ from: action.from, to: action.to }));
        let writeIssued = false;
        try {
          // Never consult the name dropdown: the label is free text.
          // Do not mutate the owner's validation rules or formatting.
          cell.setValue(action.to);
          writeIssued = true;
          SpreadsheetApp.flush();
          if (String(cell.getDisplayValue()) !== action.to) {
            throw Error('Sheet did not retain the requested text');
          }
        } catch (e) {
          if (!writeIssued && String(cell.getDisplayValue()) === action.from) {
            // Rejected before changing the cell: clear pending and report safely.
            props.deleteProperty(pendingKey);
            report.conflicts.push(a1 + ' (Sheet rejected write: ' + e.message + ')');
            return;
          }
          throw e; // Unknown partial write: keep PENDING_ for manual review.
        }
        if (action.to === '') delete owned[String(action.hour)];
        else owned[String(action.hour)] = action.to;
        saveLedger_(props, key, owned);
        props.deleteProperty(pendingKey);
      });
    });
    Logger.log(JSON.stringify(report));
    if (report.conflicts.length && cfg.ownerChatId) alertOnChangedConflict_(cfg, report.conflicts);
    return report;
  } finally { lock.releaseLock(); }
}

function alertOnChangedConflict_(cfg, conflicts) {
  const p = PropertiesService.getScriptProperties();
  const signature = conflicts.slice().sort().join('|');
  if (p.getProperty('LAST_CONFLICT') === signature) return;
  sendTelegram_(cfg.telegramToken, cfg.ownerChatId,
    '⚠️ Конфликты синхронизации:\n' + conflicts.slice(0, 15).join('\n'));
  p.setProperty('LAST_CONFLICT', signature);
}

function parseRussianSlot_(text, now) {
  const s = String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/[–—]/g, '-');
  const intervals = [...s.matchAll(/(?:^|\s)(?:с\s*|от\s*)?(\d{1,2})(?::\d{2})?\s*(?:до|по|-)\s*(\d{1,2})(?::\d{2})?(?=\D|$)/g)];
  if (intervals.length > 1) {
    return { error: 'Укажи один интервал времени или отправь отдельные запросы.' };
  }
  const numericDates = s.match(/(?:^|[^\d])[0-3]?\d[./][01]?\d(?:[./]\d{2,4})?/g) || [];
  const namedDates = s.match(/\b[0-3]?\d\s+(?:январ\w*|феврал\w*|март\w*|апрел\w*|мая|май|июн\w*|июл\w*|август\w*|сентябр\w*|октябр\w*|ноябр\w*|декабр\w*)/g) || [];
  if (numericDates.length + namedDates.length > 1) {
    return { error: 'Укажи одну дату в сообщении или отправь отдельные запросы.' };
  }
  if (/\b\d{1,2}\s+и\s+\d{1,2}\s+(?:январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр)/.test(s)) {
    return { error: 'Укажи одну дату в сообщении (или отправь отдельные запросы).' };
  }
  const t = s.match(/(?:^|\s)(?:с\s*|от\s*)?(\d{1,2})(?::(\d{2}))?\s*(?:до|по|-)\s*(\d{1,2})(?::(\d{2}))?(?=\D|$)/);
  if (!t) return { error: 'Укажи интервал, например: «22 ноября с 15:30 до 17:00».' };
  const a = Number(t[1]) * 60 + Number(t[2] || 0);
  const b = Number(t[3]) * 60 + Number(t[4] || 0);
  if (Number(t[1]) > 23 || Number(t[3]) > 24 || Number(t[2] || 0) > 59 ||
      Number(t[4] || 0) > 59 || b <= a || b > 1440) {
    return { error: 'Не удалось однозначно разобрать время.' };
  }
  const today = localDay_(now);
  let date = null;
  if (/(?:^|[^а-я])послезавтра(?:$|[^а-я])/.test(s)) {
    date = new Date(today); date.setDate(date.getDate() + 2);
  } else if (/(?:^|[^а-я])завтра(?:$|[^а-я])/.test(s)) {
    date = new Date(today); date.setDate(date.getDate() + 1);
  } else if (/(?:^|[^а-я])сегодня(?:$|[^а-я])/.test(s)) date = today;
  const numeric = s.match(/(?:^|[^\d])([0-3]?\d)[./]([01]?\d)(?:[./](\d{2,4}))?(?!\d)/);
  if (!date && numeric && Number(numeric[2]) >= 1 && Number(numeric[2]) <= 12) {
    let year = numeric[3] ? Number(numeric[3]) : today.getFullYear();
    if (year < 100) year += 2000;
    date = new Date(year, Number(numeric[2]) - 1, Number(numeric[1]));
    if (!numeric[3] && date < today) date.setFullYear(date.getFullYear() + 1);
    if (date.getDate() !== Number(numeric[1])) return { error: 'Некорректная дата.' };
  }
  const months = ['январ', 'феврал', 'март', 'апрел', 'мая', 'июн', 'июл',
    'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
  const named = s.match(/(?:^|\s)([0-3]?\d)\s+(январ\w*|феврал\w*|март\w*|апрел\w*|мая|май|июн\w*|июл\w*|август\w*|сентябр\w*|октябр\w*|ноябр\w*|декабр\w*)(?:\s+(20\d{2}))?/);
  if (!date && named) {
    const month = months.findIndex(x => named[2].startsWith(x) || (x === 'мая' && named[2] === 'май'));
    if (month < 0) return { error: 'Не удалось разобрать месяц.' };
    const year = named[3] ? Number(named[3]) : today.getFullYear();
    date = new Date(year, month, Number(named[1]));
    if (date.getMonth() !== month || date.getDate() !== Number(named[1])) return { error: 'Некорректная дата.' };
    if (!named[3] && date < today) date.setFullYear(date.getFullYear() + 1);
  }
  if (!date) {
    const dayOnly = s.match(/(?:^|[^\d])([0-3]?\d)-(?:го|е)(?:$|[^а-я])/);
    if (dayOnly) {
      const dayNumber = Number(dayOnly[1]);
      for (let offset = 0; offset <= 12; offset++) {
        const candidate = new Date(today.getFullYear(), today.getMonth() + offset, dayNumber);
        if (candidate.getDate() === dayNumber && candidate >= today) {
          date = candidate; break;
        }
      }
    }
  }
  if (!date) {
    const shortDay = w => new RegExp('(?:^|[^а-я])' + w + '(?:$|[^а-я])').test(s);
    const weekday = [shortDay('вс') || /воскресен/.test(s), shortDay('пн') || /понедел/.test(s),
      shortDay('вт') || /вторник/.test(s), shortDay('ср') || /сред[ауые]/.test(s),
      shortDay('чт') || /четверг/.test(s), shortDay('пт') || /пятниц/.test(s),
      shortDay('сб') || /суббот/.test(s)].findIndex(Boolean);
    if (weekday >= 0) {
      date = new Date(today);
      date.setDate(date.getDate() + ((weekday - today.getDay() + 7) % 7));
    }
  }
  if (!date) return { error: 'Укажи дату: «22 ноября», «22.11», «завтра» или день недели.' };
  if (a < STUDIO.firstHour * 60 || b > STUDIO.lastHour * 60) {
    return { error: 'В таблице расписание только с 06:00 до 22:00.' };
  }
  return { date: dayKey_(date), from: a, to: b };
}

function overlaps_(a, b, c, d) { return a < d && b > c; }

function checkAvailability_(slot, cfg) {
  const sheet = sheet_(cfg);
  const rows = dateRows_(sheet, [slot.date]);
  if (!rows[slot.date]) throw Error('Date not present in booking sheet: ' + slot.date);
  const row = sheet.getRange(rows[slot.date], 2, 1, 16).getDisplayValues()[0];
  const properties = PropertiesService.getScriptProperties();
  if (Object.keys(properties.getProperties()).some(x => x.startsWith('PENDING_'))) {
    throw Error('Sync transaction incomplete; availability cannot be confirmed');
  }
  const ledger = ledger_(properties, slot.date);
  const start = localDateFromKey_(slot.date);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const calendarEvents = calendar_(cfg).getEvents(start, end);
  const bidirectional = properties.getProperty('BIDIR_ACTIVE') === 'true' &&
    typeof bdProject_ === 'function';
  const exactEvents = calendarEvents.filter(e => !e.isAllDayEvent() &&
    dayKey_(e.getStartTime()) === slot.date &&
    dayKey_(new Date(e.getEndTime().getTime() - 1)) === slot.date);
  const projection = bidirectional
    ? bdProject_(exactEvents.map(bdEventMeta_), slot.date) : null;
  if (projection && projection.conflicts.length) {
    throw Error('Calendar contains unrepresentable or overlapping bookings');
  }
  const busy = [];
  for (let h = STUDIO.firstHour; h < STUDIO.lastHour; h++) {
    const value = String(row[h - STUDIO.firstHour] || '');
    if (!value.trim()) continue;
    // V2 rows were projected from live Calendar events: use exact Calendar
    // end times rather than counting the rounded last Sheet hour as busy.
    if (projection && projection.cells[h - STUDIO.firstHour] === value.trim()) continue;
    if (!bidirectional && ledger[String(h)] === value) continue;
    const begin = h * 60 + (/^\s*\(\s*\+30\s*\)/.test(value) ? 30 : 0);
    const end = (h + 1) * 60;
    if (overlaps_(slot.from, slot.to, begin, end)) busy.push([begin, end]);
  }
  calendarEvents.forEach(e => {
    const from = e.isAllDayEvent() ? 0 : Math.max(0,
      Math.round((e.getStartTime().getTime() - start.getTime()) / 60000));
    const to = e.isAllDayEvent() ? 1440 : Math.min(1440,
      Math.round((e.getEndTime().getTime() - start.getTime()) / 60000));
    if (overlaps_(slot.from, slot.to, from, to)) busy.push([Math.max(0, from), Math.min(1440, to)]);
  });
  return { free: busy.length === 0, busy };
}

function formatStudioTime_(minutes) {
  return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' +
    String(minutes % 60).padStart(2, '0');
}

function freeWindows_(date, cfg) {
  const opening = STUDIO.firstHour * 60;
  const closing = STUDIO.lastHour * 60;
  const busy = checkAvailability_({ date, from: opening, to: closing }, cfg).busy;
  const free = [];
  let started = null;
  for (let minute = opening; minute <= closing; minute += 30) {
    const occupied = minute < closing &&
      busy.some(([a, b]) => overlaps_(minute, minute + 30, a, b));
    if (!occupied && started === null && minute < closing) started = minute;
    if ((occupied || minute === closing) && started !== null) {
      free.push([started, minute]);
      started = null;
    }
  }
  return free;
}

function answerTelegram_(text, chatId) {
  // Telegram forwards retain their text; no LLM or external parsing API is needed.
  // All answers are read-only and are based on the current Sheet + live Calendar.
  if (/^\/(?:start|help)(?:@\w+)?(?:\s|$)/i.test(String(text || '')) ||
      /^помощь\s*$/i.test(String(text || ''))) {
    return '👋 Проверяю свободное время студии.\n' +
      'Пришли или перешли сообщение с датой и интервалом, например:\n' +
      '«22 ноября с 15:30 до 17:00»\n' +
      '«Завтра с 18 до 19:30»\n' +
      '«/free 22 ноября» — свободные окна\n' +
      'Я только проверяю занятость; бронирование не создаю.';
  }
  const cfg = config_();
  if (/^\/status(?:\s|$)/i.test(String(text || ''))) {
    if (!cfg.ownerChatId || String(chatId) !== String(cfg.ownerChatId)) {
      return '🔒 Статус доступен только администратору.';
    }
    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty('BD_LAST_SYNC');
    const status = raw ? JSON.parse(raw) : null;
    return status
      ? 'Последняя сверка: ' + status.at + '\nРежим: ' + status.mode +
        '\nДней обновлено: ' + status.days + '\nКонфликтов: ' + status.conflicts
      : 'Сверка ещё не запускалась.';
  }
  if (/^\/free(?:\s|$)/i.test(String(text || ''))) {
    const request = String(text).replace(/^\/free\s*/i, '').trim();
    const day = parseRussianSlot_(request + ' с 06:00 до 22:00', new Date());
    if (day.error) return day.error;
    const windows = freeWindows_(day.date, cfg);
    return windows.length
      ? '🟢 Свободные окна ' + day.date + ':\n' +
        windows.map(([a, b]) => formatStudioTime_(a) + '–' + formatStudioTime_(b)).join('\n')
      : '🔴 Свободных окон ' + day.date + ' нет.';
  }
  const clauses = String(text || '').split(/[;\n]+/).map(x => x.trim()).filter(Boolean);
  if (clauses.length > 1) {
    if (clauses.length > 5) return 'Можно проверить не больше пяти интервалов за раз.';
    return clauses.map(x => answerTelegram_(x, chatId)).join('\n\n');
  }
  const slot = parseRussianSlot_(text, new Date());
  if (slot.error) return slot.error;
  const answer = checkAvailability_(slot, cfg);
  const period = slot.date + ' ' + formatStudioTime_(slot.from) + '–' + formatStudioTime_(slot.to);
  if (answer.free) return '✅ По известному расписанию свободно: ' + period;
  return '❌ Занято: ' + period + '\nПересечения: ' +
    answer.busy.map(x => formatStudioTime_(x[0]) + '–' + formatStudioTime_(x[1])).join(', ') +
    '\n(Без раскрытия имён и деталей занятий.)';
}

function telegramApi_(token, method, payload) {
  if (!token) throw Error('Set TELEGRAM_TOKEN in Script properties');
  const response = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const json = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200 || !json.ok) {
    throw Error('Telegram ' + method + ': ' + (json.description || response.getResponseCode()));
  }
  return json.result;
}

function sendTelegram_(token, chatId, text) {
  return telegramApi_(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 3900) });
}

/** Minute-triggered pull: no public web app and no Google credential exposed. */
function pollTelegram() {
  // Telegram's offset is separate from Sheet/Calendar state: it must not
  // wait for a 120-day reconciliation under the global script lock.
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return; // global lock also prevents overlapping sync
  try {
    const cfg = config_();
    const props = PropertiesService.getScriptProperties();
    const offset = Number(props.getProperty('TG_OFFSET') || 0);
    const updates = telegramApi_(cfg.telegramToken, 'getUpdates', {
      offset, limit: 20, timeout: 0, allowed_updates: ['message'],
    });
    updates.forEach(update => {
      const message = update.message;
      if (message && message.chat && (message.text || message.caption)) {
        let reply;
        try {
          const cache = CacheService.getScriptCache();
          const rateKey = 'TG_RATE_' + String(message.chat.id);
          const requests = Number(cache.get(rateKey) || 0);
          if (requests >= 10) {
            reply = '⏳ Слишком много запросов. Подожди минуту и попробуй снова.';
          } else {
            cache.put(rateKey, String(requests + 1), 60);
            reply = answerTelegram_(message.text || message.caption, message.chat.id);
          }
        }
        catch (e) { Logger.log(String(e)); reply = '⚠️ Не удалось подтвердить свободное время. Попробуй позже.'; }
        sendTelegram_(cfg.telegramToken, message.chat.id, reply);
      }
      props.setProperty('TG_OFFSET', String(update.update_id + 1));
    });
  } finally { lock.releaseLock(); }
}

function installTriggers() {
  if (PropertiesService.getScriptProperties().getProperty('BIDIR_ACTIVE') === 'true') {
    throw Error('Legacy trigger installer disabled while bidirectional sync is active');
  }
  config_();
  const names = new Set(['syncCalendarToSheet', 'pollTelegram']);
  ScriptApp.getProjectTriggers().forEach(t => {
    if (names.has(t.getHandlerFunction())) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncCalendarToSheet').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  Logger.log('Triggers installed. WRITE_ENABLED remains unchanged.');
}

function dryRun() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('WRITE_ENABLED') === 'true') {
    throw Error('Set WRITE_ENABLED=false before running dryRun');
  }
  return syncCalendarToSheet();
}
