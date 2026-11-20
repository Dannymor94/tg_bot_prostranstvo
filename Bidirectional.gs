/**
 * Bidirectional booking bridge for the TEST studio calendar and Sheet.
 * A snapshot per day makes source detection deterministic: exactly one side
 * may change since the preceding successful reconciliation.
 *
 * Installable onEdit and Calendar event-updated triggers provide quick updates;
 * the fifteen-minute timer also catches edits that Google doesn't trigger.
 */
const BD = Object.freeze({
  prefix: 'BD_STATE_',
  marker: '[STUDIO_BIDIR_V1]',
  halfMarker: '(+30) Мин',
  days: 120,
  auditSheet: '_BD_AUDIT',
  maxAutomaticDeletes: 2,
  activeProperty: 'BIDIR_ACTIVE',
  bootstrapProperty: 'BIDIR_BOOTSTRAPPING',
  testSpreadsheet: '1FNufCunHlY5m4HAzBnRcZKRJtM7YfKKHcDehN8SGUxo',
  testCalendar: '48dcda42a1404258847154571d9d674473f8580900e3fd5e7b6ca049cbc863b8@group.calendar.google.com',
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
function bdBookings_(cells, key, knownEvents = []) {
  const row = bdClean_(cells);
  const segments = [];
  row.forEach((value, i) => {
    if (!value) return;
    const h = STUDIO.firstHour + i;
    const half = bdIsHalf_(value);
    let name = value;
    if (half) {
      // An isolated Calendar 15:30-16:00 event may sit before a different
      // booking at 16:00. The next cell's name does NOT belong to it then.
      const candidates = knownEvents.filter(e =>
        bdMinutes_(new Date(e.start)) === h * 60 + 30 &&
        bdMinutes_(new Date(e.end)) === (h + 1) * 60);
      if (candidates.length > 1) throw Error(key + ' ' + h + ': ambiguous half-hour identity');
      name = candidates.length === 1 ? candidates[0].title : (row[i + 1] || '');
      if (!name || bdIsHalf_(name)) throw Error(key + ' ' + h + ': +30 without next name');
    }
    const start = h * 60 + (half ? 30 : 0);
    const end = (h + 1) * 60;
    const previous = segments[segments.length - 1];
    const distinctEvents = knownEvents.some(e =>
      e.title === name && bdMinutes_(new Date(e.end)) === start) &&
      knownEvents.some(e =>
        e.title === name && bdMinutes_(new Date(e.start)) === start);
    if (previous && previous.end === start && previous.title === name && !distinctEvents) {
      previous.end = end;
    }
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
      new Date(event.start).getSeconds() !== 0 || new Date(event.end).getSeconds() !== 0 ||
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
  // A checkpoint can never legitimize a divergent pair of sources, even if
  // neither source has changed since the checkpoint was taken.
  if (!sheetChanged && !calChanged) {
    return bdEqual_(sheetNow, projection.cells) ? { kind: 'none' } :
      { kind: 'conflict', problems: [key + ': checkpoint contains divergent sources'] };
  }
  if (sheetChanged && calChanged) {
    if (bdEqual_(sheetNow, projection.cells)) return { kind: 'adopt' };
    if (!prior && bootstrap) {
      // A preceding import run may have stopped between event creation and
      // the daily checkpoint. Resume only if every existing event is an exact
      // subset of the bookings from the Sheet.
      const bookings = bdBookings_(sheetNow, key, calNow);
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
    try { bookings = bdBookings_(sheetNow, key, prior ? prior.events : []); }
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
    if (event.isAllDayEvent()) {
      const day = dayKey_(event.getStartTime());
      if (known.has(day)) unsupported.push(day + ': all-day event');
      continue;
    }
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

function bdWriteGuard_(cfg, props) {
  if (props.getProperty('WRITE_ENABLED') !== 'true') {
    throw Error('WRITE_ENABLED must be true for bidirectional writes');
  }
  if (cfg.spreadsheetId === BD.testSpreadsheet && cfg.calendarId === BD.testCalendar) return;
  if (props.getProperty('BIDIR_PRODUCTION_APPROVED') !==
      cfg.spreadsheetId + '|' + cfg.calendarId) {
    throw Error('Production IDs not explicitly approved; refusing bidirectional writes');
  }
}

function bdPreflightError_(message) {
  const error = Error(message);
  error.safeNoWrite = true;
  return error;
}

function bdCleanupState_(props, today) {
  const current = dayKey_(today);
  if (props.getProperty('BD_LAST_GC') === current) return;
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 7);
  const old = dayKey_(cutoff);
  const values = props.getProperties();
  Object.keys(values).forEach(k => {
    if (k.startsWith(BD.prefix) && k.slice(BD.prefix.length) < old) props.deleteProperty(k);
  });
  props.setProperty('BD_LAST_GC', current);
}

function bdCreateFromSheet_(calendar, key, bookings, existing, prior) {
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
  // An edit to the Sheet may not remove an event that was never checkpointed.
  // This is especially important for direct Calendar edits racing with onEdit.
  const checkpointed = new Set((prior ? prior.events : []).map(e => e.id));
  if (unused.some(e => !checkpointed.has(e.meta.id))) {
    throw bdPreflightError_(key + ': refusing to delete an event absent from the previous snapshot');
  }
  if (unused.some(e => e.event.isRecurringEvent && e.event.isRecurringEvent())) {
    throw bdPreflightError_(key + ': recurring events require direct Calendar editing');
  }
  if (!pending.length && unused.length > BD.maxAutomaticDeletes) {
    throw bdPreflightError_(key + ': bulk deletion needs explicit manual review');
  }
  let updated = 0;
  // In a unique one-to-one edit keep the original Calendar event ID, guests,
  // reminders and description. Multiple candidates are ambiguous and require
  // explicit resolution; never coalesce adjacent same-name events.
  if (pending.length && unused.length) {
    if (pending.length !== 1 || unused.length !== 1) {
      throw bdPreflightError_(key + ': ambiguous event identity; keeping calendar unchanged');
    }
    const target = pending.pop();
    const old = unused.pop();
    if (old.meta.title !== target.title &&
        (old.meta.start !== target.start || old.meta.end !== target.end)) {
      throw bdPreflightError_(key + ': combined rename and move is ambiguous');
    }
    if (!bdEqual_(bdEventMeta_(old.event), old.meta)) {
      throw bdPreflightError_(key + ': Calendar event changed during reconciliation');
    }
    if (old.meta.title !== target.title) old.event.setTitle(target.title);
    if (old.meta.start !== target.start || old.meta.end !== target.end) {
      old.event.setTime(new Date(target.start), new Date(target.end));
    }
    updated++;
  }
  // Create before deleting, so a failure doesn't erase existing reservations.
  for (const booking of pending) {
    calendar.createEvent(booking.title, new Date(booking.start), new Date(booking.end),
      { description: BD.marker + ' Imported from test booking Sheet; edits synchronize both ways.' });
  }
  for (const old of unused) {
    if (!bdEqual_(bdEventMeta_(old.event), old.meta)) {
      throw Error(key + ': Calendar event changed before deletion');
    }
    old.event.deleteEvent();
  }
  return { created: pending.length, deleted: unused.length, updated };
}

/** A retained, timestamped record of every intended mutation, in the TEST Sheet. */
function bdAudit_(sheet, key, source, events, plan) {
  const book = sheet.getParent();
  if (!book) throw Error('Cannot open spreadsheet audit log');
  let audit = book.getSheetByName(BD.auditSheet);
  if (!audit) {
    audit = book.insertSheet(BD.auditSheet);
    audit.appendRow(['Время (UTC)', 'Дата', 'Источник', 'До: таблица',
      'До: календарь', 'План операции']);
    audit.hideSheet();
  }
  audit.appendRow([new Date().toISOString(), key, plan.kind,
    JSON.stringify(source.cells), JSON.stringify(bdSortMeta_(events)),
    JSON.stringify(plan)]);
}

/** Both sources must still match the inputs from which the plan was built. */
function bdPreflightDay_(calendar, sheet, key, source, events) {
  const currentSheet = bdClean_(sheet.getRange(source.row, 2, 1, 16).getDisplayValues()[0]);
  if (!bdEqual_(currentSheet, source.cells)) {
    throw bdPreflightError_(key + ': Sheet changed before write');
  }
  const start = localDateFromKey_(key);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const current = bdCalendarDays_(calendar, start, end, [key]);
  if (current.unsupported.length ||
      !bdEqual_(bdSortMeta_(current.grouped[key].map(x => x.meta)),
        bdSortMeta_(events.map(x => x.meta)))) {
    throw bdPreflightError_(key + ': Calendar changed before write');
  }
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
    bdWriteGuard_(cfg, props);
    const today = localDay_(new Date());
    const keys = selectedKeys
      ? [...new Set(selectedKeys)].filter(k => /^\d{4}-\d\d-\d\d$/.test(k) && k >= dayKey_(today)).sort()
      : bdDates_(today, BD.days);
    if (!keys.length) return { mode, applied: true, days: 0, created: 0,
      deleted: 0, updated: 0, sheetCells: 0, conflicts: [] };
    const from = localDateFromKey_(keys[0]);
    const end = localDateFromKey_(keys[keys.length - 1]);
    end.setDate(end.getDate() + 1);
    const sheet = sheet_(cfg);
    const calendar = calendar_(cfg);
    const dates = bdReadDays_(sheet, keys);
    const { grouped, unsupported } = bdCalendarDays_(calendar, from, end, keys);
    const plans = [];
    const conflicts = unsupported.slice();
    const blockedDays = new Set(unsupported.map(s => s.slice(0, 10)));
    for (const key of keys) {
      if (blockedDays.has(key)) continue;
      const source = dates[key];
      const events = grouped[key].map(x => x.meta);
      const prior = bdState_(props, key);
      if (props.getProperty('BD_PENDING_' + key)) {
        conflicts.push(key + ': incomplete transaction requires recovery');
        continue;
      }
      if (!source) {
        if (events.length || prior) conflicts.push(key + ': date absent from Sheet');
        continue;
      }
      const plan = bdPlanDay_(key, source.cells, events, prior, mode === 'bootstrap');
      if (plan.kind === 'calendar' && prior &&
          prior.events.length > BD.maxAutomaticDeletes && !events.length) {
        conflicts.push(key + ': bulk Calendar deletion requires restoring or reviewing bookings');
      }
      else if (plan.kind === 'conflict') conflicts.push(...plan.problems);
      else if (plan.kind !== 'none') plans.push({ key, source, events: grouped[key], prior, plan });
    }
    if (mode === 'bootstrap' && conflicts.length) {
      Logger.log(JSON.stringify({ mode, conflicts: conflicts.slice(0, 30) }));
      return { mode, applied: false, conflicts };
    }
    let created = 0, deleted = 0, updated = 0, sheetCells = 0, appliedDays = 0;
    for (const item of plans) {
      const { key, source, events, prior, plan } = item;
      try {
        bdPreflightDay_(calendar, sheet, key, source, events);
        bdAudit_(sheet, key, source, events.map(x => x.meta), plan);
        props.setProperty('BD_PENDING_' + key,
          JSON.stringify({ mode, started: Date.now(), kind: plan.kind }));
        if (plan.kind === 'sheet') {
          const done = bdCreateFromSheet_(calendar, key, plan.bookings, events, prior);
          created += done.created; deleted += done.deleted; updated += done.updated;
        } else if (plan.kind === 'calendar') {
          sheetCells += bdWriteCells_(sheet, source.row, source.cells, plan.desired);
        }
        const start = localDateFromKey_(key);
        const dayEnd = new Date(start); dayEnd.setDate(dayEnd.getDate() + 1);
        const currentEvents = calendar.getEvents(start, dayEnd).filter(e => !e.isAllDayEvent())
          .filter(e => dayKey_(e.getStartTime()) === key).map(bdEventMeta_);
        const currentSheet = sheet.getRange(source.row, 2, 1, 16).getDisplayValues()[0];
        const projection = bdProject_(currentEvents, key);
        if (projection.conflicts.length ||
            !bdEqual_(bdClean_(currentSheet), projection.cells)) {
          throw Error(key + ': postflight mismatch; transaction held for recovery');
        }
        bdSave_(props, key, currentSheet, currentEvents);
        props.deleteProperty('BD_PENDING_' + key);
        appliedDays++;
      } catch (error) {
        if (error.safeNoWrite) props.deleteProperty('BD_PENDING_' + key);
        conflicts.push(key + ': ' + String(error.message || error));
      }
    }
    bdCleanupState_(props, today);
    const report = { mode, applied: conflicts.length === 0, partial: conflicts.length > 0,
      days: appliedDays, created, deleted, updated, sheetCells, conflicts };
    props.setProperty('BD_LAST_SYNC', JSON.stringify({
      at: new Date().toISOString(), mode, days: appliedDays, conflicts: conflicts.length }));
    if (conflicts.length && cfg.ownerChatId) {
      alertOnChangedConflict_(cfg, conflicts);
    }
    Logger.log(JSON.stringify(report));
    return report;
  } finally { lock.releaseLock(); }
}

/** One-time future booking import, resilient to repeated calls. */
function bdImportExistingBookings() {
  const cfg = config_();
  const props = PropertiesService.getScriptProperties();
  if (cfg.spreadsheetId !== BD.testSpreadsheet ||
      cfg.calendarId !== BD.testCalendar) {
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

/** Inspect a crash journal; recover only days already converged exactly. */
function bdRecoverPending() {
  const cfg = config_();
  const props = PropertiesService.getScriptProperties();
  bdWriteGuard_(cfg, props);
  const pending = Object.keys(props.getProperties())
    .filter(k => k.startsWith('BD_PENDING_'));
  const recovered = [], blocked = [];
  if (!pending.length) return { recovered, blocked };
  const sheet = sheet_(cfg), calendar = calendar_(cfg);
  for (const name of pending) {
    const key = name.slice('BD_PENDING_'.length);
    const source = bdReadDays_(sheet, [key])[key];
    if (!source) { blocked.push(key + ': missing Sheet row'); continue; }
    const start = localDateFromKey_(key);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const list = calendar.getEvents(start,end);
    if (list.some(e => e.isAllDayEvent())) {
      blocked.push(key + ': all-day event'); continue;
    }
    const events = list.filter(e => dayKey_(e.getStartTime()) === key).map(bdEventMeta_);
    const prior = bdState_(props, key);
    const plan = bdPlanDay_(key, source.cells, events, prior);
    if (!['none', 'adopt'].includes(plan.kind)) {
      blocked.push(key + ': state diverged; manual recovery required'); continue;
    }
    bdSave_(props, key, source.cells, events);
    props.deleteProperty(name);
    recovered.push(key);
  }
  return { recovered, blocked };
}

function bdPause() {
  PropertiesService.getScriptProperties().setProperty('BIDIR_PAUSED','true');
  return 'Synchronization paused; Telegram availability remains read-only';
}

function bdResume() {
  const cfg=config_();
  const props=PropertiesService.getScriptProperties();
  bdWriteGuard_(cfg,props);
  const blocked=Object.keys(props.getProperties()).filter(k=>k.startsWith('BD_PENDING_'));
  if (blocked.length) throw Error('Recover pending days before resuming: '+blocked.join(', '));
  props.deleteProperty('BIDIR_PAUSED');
  return 'Synchronization resumed';
}

/**
 * One-time, idempotent installation for the TEST bridge.
 * Keeps Telegram polling intact; replaces ONLY the obsolete one-way sync.
 */
function bdInstallTriggers() {
  const cfg = config_();
  if (cfg.spreadsheetId !== BD.testSpreadsheet ||
      cfg.calendarId !== BD.testCalendar) {
    throw Error('Trigger installation is TEST-only');
  }
  const triggers = ScriptApp.getProjectTriggers();
  if (!triggers.some(t => t.getHandlerFunction() === 'bdOnSheetEdit')) {
    ScriptApp.newTrigger('bdOnSheetEdit').forSpreadsheet(cfg.spreadsheetId).onEdit().create();
  }
  if (!triggers.some(t => t.getHandlerFunction() === 'bdOnCalendarChange')) {
    ScriptApp.newTrigger('bdOnCalendarChange').forUserCalendar(cfg.calendarId).onEventUpdated().create();
  }
  // Reinstall the timer with an affordable cadence. Event triggers handle
  // ordinary manual edits promptly; this is only a reconciliation fallback.
  triggers.filter(t => t.getHandlerFunction() === 'bdTimer')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('bdTimer').timeBased().everyMinutes(15).create();
  for (const old of triggers.filter(t => t.getHandlerFunction() === 'syncCalendarToSheet')) {
    ScriptApp.deleteTrigger(old);
  }
  return ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
}
