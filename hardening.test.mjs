import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = ['Code.gs', 'Bidirectional.gs', 'TelegramUX.gs']
  .map(name => fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8'));

function fixture() {
  const entries = new Map([['WRITE_ENABLED', 'true'], ['BIDIR_ACTIVE', 'true']]);
  const props = {
    getProperty: k => entries.get(k) ?? null,
    setProperty: (k, v) => entries.set(k, String(v)),
    deleteProperty: k => entries.delete(k),
    getProperties: () => Object.fromEntries(entries),
  };
  let flushes = 0;
  const ctx = vm.createContext({
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }),
      getUserLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    SpreadsheetApp: { flush: () => { flushes++; } },
    Logger: { log: () => {} },
    Utilities: { formatDate: d => d.toISOString().slice(0, 10) },
  });
  source.forEach(code => vm.runInContext(code, ctx));
  const run = expr => vm.runInContext(expr, ctx);
  ctx.config_ = () => ({ spreadsheetId: 'test-sheet', calendarId: 'test-calendar',
    telegramToken: 'fake', ownerChatId: '' });
  return { ctx, run, entries, props, flushCount: () => flushes };
}

test('Telegram transport exception never exposes bot token or raw URL', () => {
  const { ctx, run } = fixture();
  const token = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  ctx.UrlFetchApp = { fetch: () => {
    throw Error('Address unavailable: https://api.telegram.org/bot' + token + '/getUpdates');
  } };
  ctx.fakeToken = token;
  assert.throws(() => run('telegramApi_(fakeToken,"getUpdates",{})'), error =>
    error.message === 'Telegram getUpdates: network unavailable' &&
    !error.stack.includes(token) && !error.stack.includes('api.telegram.org'));
});

test('Telegram bad gateway response is reported without a raw body', () => {
  const { ctx, run } = fixture();
  ctx.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 502,
    getContentText: () => '<html>bad gateway</html>' }) };
  assert.throws(() => run('telegramApi_("fake","getUpdates",{})'),
    /Telegram getUpdates: invalid response \(HTTP 502\)/);
});

test('failed Telegram reply becomes durable dead letter and can be replayed', () => {
  const { ctx, run, entries, props } = fixture();
  const original = { chatId: 101, reply: 'Ответ о свободном времени',
    editMessageId: null, markup: null, attempts: 2, nextAt: 0 };
  entries.set('TG_OUTBOX_45', JSON.stringify(original));
  let fail = true;
  const delivered = [];
  ctx.telegramApi_ = (_token, method, payload) => {
    if (fail) throw Error('Temporary outage');
    delivered.push({ method, payload });
    return true;
  };
  ctx.testProps = props;
  run('tgDeliverOutbox_({telegramToken:"fake",ownerChatId:""},testProps)');
  assert.equal(entries.has('TG_OUTBOX_45'), false);
  assert.equal(entries.has('TG_DEAD_45'), true);
  assert.equal(JSON.parse(entries.get('TG_DEAD_45')).reply, original.reply);
  assert.equal(entries.get('TG_FAILED_COUNT'), '1');
  fail = false;
  assert.equal(run('tgRetryFailedReplies()').retried, 1);
  assert.equal(entries.has('TG_DEAD_45'), false);
  assert.equal(entries.has('TG_OUTBOX_45'), false);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].payload.text, original.reply);
});

test('batch writes touch changed ranges only and flush once', () => {
  const { ctx, run, flushCount } = fixture();
  const cells = Array(16).fill('');
  cells[4] = 'Бронь';
  cells[5] = 'Формула';
  const old = cells.slice();
  const next = cells.slice();
  next[1] = 'Новое';
  next[4] = '';
  next[10] = '(+30) Мин';
  next[11] = 'Тест';
  const written = [];
  ctx.testSheet = { getRange: (row, column, _height = 1, width = 1) => ({
    getDisplayValues: () => [cells.slice(column - 2, column - 2 + width)],
    getA1Notation: () => 'R' + row + 'C' + column,
    setValues: values => {
      written.push({ column, width });
      values[0].forEach((v, offset) => { cells[column - 2 + offset] = v; });
    },
  }) };
  ctx.testOld = old; ctx.testNext = next;
  assert.equal(run('bdWriteCells_(testSheet,42,testOld,testNext)'), 4);
  assert.equal(flushCount(), 1);
  assert.deepEqual(Array.from(cells), next);
  assert.deepEqual(written, [{ column: 3, width: 1 }, { column: 6, width: 1 },
    { column: 12, width: 2 }]);
});

test('concurrent Sheet edit blocks batch before any overwrite', () => {
  const { ctx, run } = fixture();
  const cells = Array(16).fill('');
  cells[3] = 'Изменено вручную';
  let writes = 0;
  ctx.testSheet = { getRange: (_row, col, _height, width) => ({
    getDisplayValues: () => [cells.slice(col - 2, col - 2 + width)],
    setValues: () => { writes++; }, getA1Notation: () => 'test-range',
  }) };
  ctx.testOld = Array(16).fill('');
  ctx.testNext = Array(16).fill(''); ctx.testNext[2] = 'Бронь';
  assert.throws(() => run('bdWriteCells_(testSheet,42,testOld,testNext)'), /concurrent Sheet modification/);
  assert.equal(writes, 0);
});

test('timer contention is a benign skip, not an operational failure', () => {
  const { ctx, run } = fixture();
  let waitMs = null;
  ctx.LockService = { getScriptLock: () => ({ tryLock: ms => { waitMs = ms; return false; },
    releaseLock: () => {} }) };
  const result = run('bdTimer()');
  assert.equal(result.skipped, true);
  assert.equal(waitMs, 0);
  assert.throws(() => run('bdReconcile_("sheet-edit",[])'), /already running/);
});

test('pending recovery refuses to race against another writer', () => {
  const { ctx, run } = fixture();
  ctx.LockService = { getScriptLock: () => ({ tryLock: () => false,
    releaseLock: () => { throw Error('should not release'); } }) };
  assert.throws(() => run('bdRecoverPending()'), /Cannot recover/);
});

test('trigger cadence cannot change to 12 hours without working Calendar API', () => {
  const { ctx, run, entries } = fixture();
  ctx.config_ = () => ({ spreadsheetId: '1FNufCunHlY5m4HAzBnRcZKRJtM7YfKKHcDehN8SGUxo',
    calendarId: '48dcda42a1404258847154571d9d674473f8580900e3fd5e7b6ca049cbc863b8@group.calendar.google.com' });
  let triggersTouched = 0;
  ctx.ScriptApp = { getProjectTriggers: () => { triggersTouched++; return []; } };
  assert.throws(() => run('bdInstallTriggers()'), /sync token not committed/);
  assert.equal(triggersTouched, 0);
  entries.set('BD_CAL_SYNC_TOKEN', 'test-token');
  ctx.bdApiPreflight = () => { throw Error('Calendar API 403'); };
  assert.throws(() => run('bdInstallTriggers()'), /Calendar API 403/);
  assert.equal(triggersTouched, 0);
});

test('production binding refuses reused test checkpoints', () => {
  const { ctx, run, entries } = fixture();
  ctx.config_ = () => ({ spreadsheetId: 'production-sheet', calendarId: 'production-calendar' });
  entries.set('BIDIR_PRODUCTION_APPROVED', 'production-sheet|production-calendar');
  assert.throws(() => run('bdBindFreshTarget()'), /existing sync checkpoints/);
  entries.delete('BIDIR_ACTIVE');
  entries.set('BD_STATE_2026-11-23', '{}');
  assert.throws(() => run('bdBindFreshTarget()'), /existing sync checkpoints/);
  entries.delete('BD_STATE_2026-11-23');
  assert.match(run('bdBindFreshTarget()'), /Fresh target bound/);
  assert.equal(entries.get('BD_TARGET_BINDING'), 'production-sheet|production-calendar');
  assert.doesNotThrow(() => run('bdWriteGuard_(config_(),PropertiesService.getScriptProperties())'));
});

test('owner status displays preserved undelivered Telegram replies', () => {
  const { ctx, run, entries } = fixture();
  ctx.config_ = () => ({ ownerChatId: '42' });
  entries.set('TG_DEAD_77', '{}');
  entries.set('TG_FAILED_COUNT', '3');
  assert.match(run('tgUxStatus_(42)').text, /Ожидают повторной отправки: 1/);
  assert.match(run('tgUxStatus_(42)').text, /Ошибок доставки Telegram \(всего\): 3/);
  assert.doesNotMatch(run('tgUxStatus_(1)').text, /Ожидают повторной отправки/);
});

test('owner status respects the approved twelve-hour backup cadence', () => {
  const { ctx, run, entries } = fixture();
  ctx.config_ = () => ({ ownerChatId: '42' });
  entries.set('BD_LAST_SYNC', JSON.stringify({
    at: new Date(Date.now() - 3600000).toISOString(), mode: 'timer', days: 0, conflicts: 0,
  }));
  assert.match(run('tgUxStatus_(42)').text, /⚠️ нет недавней сверки/);
  entries.set('BD_TIMER_HOURS', '12');
  assert.match(run('tgUxStatus_(42)').text, /в пределах резервного интервала/);
});
