/**
 * Bidirectional booking bridge for the TEST studio calendar and Sheet.
 * A snapshot per day makes source detection deterministic: exactly one side
 * may change since the preceding successful reconciliation.
 *
 * Installable onEdit and Calendar event-updated triggers provide quick updates;
 * the five-minute timer also catches edits that Google doesn't trigger.
 */
const BD = Object.freeze({
  prefix: 'BD_STATE_',
  marker: '[STUDIO_BIDIR_V1]',
  halfMarker: '(+30) Мин',
  days: 120,
  activeProperty: 'BIDIR_ACTIVE',
  bootstrapProperty: 'BIDIR_BOOTSTRAPPING',
});

function bdNonempty_(cells) { return cells.some(x => String(x || '').trim()); }
function bdEqual_(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function bdClean_(cells) {
  return Array.from({ length: 16 }, (_, i) => String(cells[i] == null ? '' : cells[i]).trim());
}
function bdIsHalf_(value) { return /^\s*\(\s*\+30\s*\)/.test(String(value)); }
function bdMinutes_(date) {
  const value = Utilities.formatDate(date, STUDIO.timezone, 'HH:mm');
  const [h, m] = value.split(':').map(Number);
  return h * 60 + m;
}
function bdEventMeta_(event) {
  return { id: event.getId(), title: String(event.getTitle() || '').trim(),
    start: event.getStartTime().getTime(), end: event.getEndTime().getTime() };
}
function bdSortMeta_(items) {
  return items.map(x => ({ id: x.id, title: x.title, start: x.start, end: x.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end ||
      a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** Sheet cells to canonical, contiguous bookings. +30 borrows the NEXT name. */
function bdBookings_(cells, key) {
  const row = bdClean_(cells);
  const segments = [];
  row.forEach((value, i) => {
    if (!value) return;
    const h = STUDIO.firstHour + i;
    const half = bdIsHalf_(value);
    let name = value;
    if (half) {
      name = row[i + 1] || '';
      if (!name || bdIsHalf_(name)) throw Error(key + ' ' + h + ': +30 without next name');
    }
    const start = h * 60 + (half ? 30 : 0);
    const end = (h + 1) * 60;
    const previous = segments[segments.length - 1];
    if (previous && previous.end === start && previous.title === name) previous.end = end;
    else segments.push({ title: name, start, end });
  });
  return segments;
}

/** Calendar events to hourly sheet cells. :30 end is necessarily conservative. */
function bdProject_(events, key) {
  const desired = Array(16).fill('');
  const collisions = [];
  for (const event of events) {
    const from = bdMinutes_(new Date(event.start));
    const to = bdMinutes_(new Date(event.end));
    if (!event.title || from < 360 || to > 1320 || from >= to ||
      ![0, 30].includes(from % 60) || ![0, 30].includes(to % 60)) {
      collisions.push(key + ': event has unsupported time/name');
      continue;
    }
    for (let h = 6; h < 22; h++) {
      if (!(from < (h + 1) * 60 && to > h * 60)) continue;
      const next = (from === h * 60 + 30) ? BD.halfMarker : event.title;
      if (desired[h - 6]) collisions.push(key + ' ' + h + ': overlapping events');
      else desired[h - 6] = next;
    }
  }
  return { cells: desired, conflicts: collisions };
}

function bdState_(properties, key) {
  const raw = properties.getProperty(BD.prefix + key);
  return raw ? JSON.parse(raw) : null;
}
function bdSave_(properties, key, cells, events) {
  const state = { cells: bdClean_(cells), events: bdSortMeta_(events) };
  if (!bdNonempty_(state.cells) && !state.events.length) properties.deleteProperty(BD.prefix + key);
  else properties.setProperty(BD.prefix + key, JSON.stringify(state));
}

/** Detect direction without guessing by last-write time. */
function bdPlanDay_(key, cells, events, prior, bootstrap = false) {
  const sheetNow = bdClean_(cells);
  const calNow = bdSortMeta_(events);
  const projection = bdProject_(calNow, key);
  if (projection.conflicts.length) return { kind: 'conflict', problems: projection.conflicts };
  const sheetChanged = prior ? !bdEqual_(sheetNow, prior.cells) : bdNonempty_(sheetNow);
  const calChanged = prior ? !bdEqual_(calNow, prior.events) : calNow.length > 0;
  if (!sheetChanged && !calChanged) return { kind: 'none' };
  if (sheetChanged && calChanged) {
    if (bdEqual_(sheetNow, projection.cells)) return { kind: 'adopt' };
    if (!prior && bootstrap) {
      // A preceding import run may have stopped between event creation and
      // the daily checkpoint. Resume only if every existing event is an exact
      // subset of the bookings from the Sheet.
      const bookings = bdBookings_(sheetNow, key);
      const start = localDateFromKey_(key).getTime();
      const expected = bookings.map(x => ({ title: x.title,
        start: start + x.start * 60000, end: start + x.end * 60000 }));
      if (calNow.every(x => expected.some(y =>
        x.title === y.title && x.start === y.start && x.end === y.end))) {
        return { kind: 'sheet', bookings };
      }
    }
    return { kind: 'conflict', problems: [key + ': Sheet and Calendar changed independently'] };
  }
  if (sheetChanged) {
    let bookings;
    try { bookings = bdBookings_(sheetNow, key); }
    catch (error) { return { kind: 'conflict', problems: [String(error.message)] }; }
    return { kind: 'sheet', bookings };
  }
  return { kind: 'calendar', desired: projection.cells };
}

function bdDates_(today, count) {
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(today); date.setDate(date.getDate() + i);
    return dayKey_(date);
  });
}

function bdReadDays_(sheet, keys) {
  const rows = dateRows_(sheet, keys);
  const found = Object.entries(rows).map(([key, row]) => ({ key, row }));
  if (!found.length) throw Error('No dates available in booking sheet');
  const first = Math.min(...found.map(x => x.row));
  const last = Math.max(...found.map(x => x.row));
  const values = sheet.getRange(first, 2, last - first + 1, 16).getDisplayValues();
  const output = {};
  for (const key of keys) {
    output[key] = rows[key] ? { row: rows[key], cells: bdClean_(values[rows[key] - first]) } : null;
  }
  return output;
}

function bdCalendarDays_(calendar, today, end, keys) {
  const known = new Set(keys);
  const grouped = {};
  for (const key of keys) grouped[key] = [];
  const unsupported = [];
  for (const event of calendar.getEvents(today, end)) {
    if (event.isAllDayEvent()) { unsupported.push('All-day calendar event'); continue; }
    const m = bdEventMeta_(event);
    const key = dayKey_(new Date(m.start));
    if (!known.has(key)) continue;
    if (dayKey_(new Date(m.end - 1)) !== key) {
      unsupported.push(key + ': multi-day event'); continue;
    }
    grouped[key].push({ event, meta: m });
  }
  return { grouped, unsupported };
}

function bdCreateFromSheet_(calendar, key, bookings, existing) {
  const unused = existing.slice();
  const pending = [];
  for (const booking of bookings) {
    const expected = { title: booking.title, start: new Date(localDateFromKey_(key).getTime() + booking.start * 60000).getTime(),
      end: new Date(localDateFromKey_(key).getTime() + booking.end * 60000).getTime() };
    const i = unused.findIndex(x => x.meta.title === expected.title &&
      x.meta.start === expected.start && (x.meta.end === expected.end ||
      // The Sheet cannot express an end at :30. Preserve exact Calendar
      // precision if the last occupied hourly cell remains the same.
      (bdMinutes_(new Date(x.meta.end)) % 60 === 30 &&
        Math.ceil(x.meta.end / 3600000) * 3600000 === expected.end)));
    if (i >= 0) unused.splice(i, 1);
    else pending.push(expected);
  }
  // Create before deleting, so a failure doesn't erase existing reservations.
  for (const booking of pending) {
    calendar.createEvent(booking.title, new Date(booking.start), new Date(booking.end),
      { description: BD.marker + ' Imported from test booking Sheet; edits synchronize both ways.' });
  }
  for (const old of unused) old.event.deleteEvent();
  return { created: pending.length, deleted: unused.length };
}

function bdWriteCells_(sheet, rowNumber, previous, desired) {
  let count = 0;
  for (let i = 0; i < 16; i++) {
    if (previous[i] === desired[i]) continue;
    const cell = sheet.getRange(rowNumber, i + 2);
    if (String(cell.getDisplayValue()).trim() !== previous[i]) {
      throw Error(cell.getA1Notation() + ': concurrent Sheet modification');
    }
    cell.setValue(desired[i]);
    SpreadsheetApp.flush();
    if (String(cell.getDisplayValue()).trim() !== desired[i]) {
      throw Error(cell.getA1Notation() + ': Sheet rejected write');
    }
    count++;
  }
  return count;
}

/**
 * Reconcile all future rows, or selected edited rows. Each day is checkpointed.
 * If independent edits collide, fail closed without applying any day's plan.
 */
function bdReconcile_(mode, selectedKeys) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw Error('Bidirectional sync already running');
  try {
    const cfg = config_();
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('BIDIR_PAUSED') === 'true') return { paused: true };
    if (mode !== 'bootstrap' && props.getProperty(BD.activeProperty) !== 'true') {
      return { inactive: true };
    }
    const today = localDay_(new Date());
    const end = new Date(today); end.setDate(end.getDate() + BD.days);
    const keys = bdDates_(today, BD.days);
    const allowed = selectedKeys ? new Set(selectedKeys) : null;
    const sheet = sheet_(cfg);
    const calendar = calendar_(cfg);
    const dates = bdReadDays_(sheet, keys);
    const { grouped, unsupported } = bdCalendarDays_(calendar, today, end, keys);
    if (unsupported.length) throw Error('Calendar has unsupported events: ' + unsupported.join('; '));
    const plans = [];
    const conflicts = [];
    for (const key of keys) {
      if (allowed && !allowed.has(key)) continue;
      const source = dates[key];
      const events = grouped[key].map(x => x.meta);
      const prior = bdState_(props, key);
      if (!source) {
        if (events.length || prior) conflicts.push(key + ': date absent from Sheet');
        continue;
      }
      const plan = bdPlanDay_(key, source.cells, events, prior, mode === 'bootstrap');
      if (plan.kind === 'conflict') conflicts.push(...plan.problems);
      else if (plan.kind !== 'none') plans.push({ key, source, events: grouped[key], plan });
    }
    if (conflicts.length) {
      Logger.log(JSON.stringify({ mode, conflicts: conflicts.slice(0, 30) }));
      return { mode, applied: false, conflicts };
    }
    let created = 0, deleted = 0, sheetCells = 0;
    for (const item of plans) {
      const { key, source, events, plan } = item;
      if (plan.kind === 'sheet') {
        const done = bdCreateFromSheet_(calendar, key, plan.bookings, events);
        created += done.created; deleted += done.deleted;
      } else if (plan.kind === 'calendar') {
        sheetCells += bdWriteCells_(sheet, source.row, source.cells, plan.desired);
      }
      const start = localDateFromKey_(key);
      const dayEnd = new Date(start); dayEnd.setDate(dayEnd.getDate() + 1);
      const currentEvents = calendar.getEvents(start, dayEnd).filter(e => !e.isAllDayEvent())
        .filter(e => dayKey_(e.getStartTime()) === key).map(bdEventMeta_);
      const currentSheet = sheet.getRange(source.row, 2, 1, 16).getDisplayValues()[0];
      bdSave_(props, key, currentSheet, currentEvents);
    }
    const report = { mode, applied: true, days: plans.length, created, deleted, sheetCells, conflicts: [] };
    Logger.log(JSON.stringify(report));
    return report;
  } finally { lock.releaseLock(); }
}

/** One-time future booking import, resilient to repeated calls. */
function bdImportExistingBookings() {
  const cfg = config_();
  const props = PropertiesService.getScriptProperties();
  if (cfg.spreadsheetId !== '1FNufCunHlY5m4HAzBnRcZKRJtM7YfKKHcDehN8SGUxo' ||
      cfg.calendarId !== '48dcda42a1404258847154571d9d674473f8580900e3fd5e7b6ca049cbc863b8@group.calendar.google.com') {
    throw Error('Import is TEST-only; refusing non-test Sheet or Calendar');
  }
  if (props.getProperty(BD.activeProperty) === 'true') throw Error('Bidirectional already active');
  const report = bdReconcile_('bootstrap');
  if (!report.applied || report.conflicts.length) throw Error('Bootstrap had conflicts; not enabling');
  props.setProperty(BD.activeProperty, 'true');
  return report;
}

/** Existing five-minute trigger should be retargeted to this function. */
function bdTimer() { return bdReconcile_('timer'); }

/** Installable onEdit trigger, bound to the exact test spreadsheet ID. */
function bdOnSheetEdit(event) {
  if (!event || !event.range || !event.source) return;
  const cfg = config_();
  if (event.source.getId() !== cfg.spreadsheetId ||
      event.range.getSheet().getName() !== STUDIO.sheetName) return;
  const range = event.range;
  if (range.getLastColumn() < 2 || range.getColumn() > 17 ||
      range.getLastRow() < STUDIO.firstDataRow) return;
  const sheet = range.getSheet();
  const first = Math.max(range.getRow(), STUDIO.firstDataRow);
  const count = range.getLastRow() - first + 1;
  const keys = sheet.getRange(first, 1, count, 1).getValues()
    .map(x => x[0] instanceof Date ? dayKey_(x[0]) : null).filter(Boolean);
  if (keys.length) bdReconcile_('sheet-edit', keys);
}

/** Installable Calendar 'Event updated' trigger (event doesn't identify change). */
function bdOnCalendarChange(event) {
  const cfg = config_();
  if (event && event.calendarId && event.calendarId !== cfg.calendarId) return;
  bdReconcile_('calendar-edit');
}

/**
 * One-time, idempotent installation for the TEST bridge.
 * Keeps Telegram polling intact; replaces ONLY the obsolete one-way sync.
 */
function bdInstallTriggers() {
  const cfg = config_();
  if (cfg.spreadsheetId !== '1FNufCunHlY5m4HAzBnRcZKRJtM7YfKKHcDehN8SGUxo' ||
      cfg.calendarId !== '48dcda42a1404258847154571d9d674473f8580900e3fd5e7b6ca049cbc863b8@group.calendar.google.com') {
    throw Error('Trigger installation is TEST-only');
  }
  const triggers = ScriptApp.getProjectTriggers();
  if (!triggers.some(t => t.getHandlerFunction() === 'bdOnSheetEdit')) {
    ScriptApp.newTrigger('bdOnSheetEdit').forSpreadsheet(cfg.spreadsheetId).onEdit().create();
  }
  if (!triggers.some(t => t.getHandlerFunction() === 'bdOnCalendarChange')) {
    ScriptApp.newTrigger('bdOnCalendarChange').forUserCalendar(cfg.calendarId).onEventUpdated().create();
  }
  if (!triggers.some(t => t.getHandlerFunction() === 'bdTimer')) {
    ScriptApp.newTrigger('bdTimer').timeBased().everyMinutes(5).create();
  }
  for (const old of triggers.filter(t => t.getHandlerFunction() === 'syncCalendarToSheet')) {
    ScriptApp.deleteTrigger(old);
  }
  return ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
}
