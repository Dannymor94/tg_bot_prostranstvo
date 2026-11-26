# Legacy Calendar import — 2026-11-26

## Current evidence and execution status

Fresh connector read confirmed 69 events, no next page, and exactly one description:

`[STUDIO_BIDIR_V1] Imported from test booking Sheet; edits synchronize both ways.`

This is the entire recognized description, not a substring match. Prefix-only markers, appended notes and unknown descriptions remain on review. No names, private IDs or raw customer snapshots are included in this repository.

Implemented and locally tested, **not installed or run live** in this checkpoint. Browser authentication request timed out and the browser runtime reset. No old handler was stopped, no new backup was made, no event was imported and no live E2E was executed. The previous checkpoint's live preflight remains historical evidence, not a fresh run. Production and Telegram were not changed.

## Implementation

- `CrmMigration.gs`: separate `_CRM_MIGRATION` archive with one immutable original event JSON per Calendar ID. New rows are REVIEW with no booking details, price or payment. Staging does not modify Calendar, Аренды or Оплаты. Duplicate IDs, formulas, stale archive writes and oversized event JSON fail closed.
- Dedicated staging/import entry points require the exact v2 TEST binding, explicit migration flag, same-target stopped-writer handover and a verified current-day backup made after handover. Write import additionally requires the TEST write flag. Neither entry point is automatically called by normal reconciliation.
- Explicit APPROVED booking JSON must identify the same `ext_<Calendar ID>`, confirmed interval and current directory's tenant/format/direction. No guessing from a name or source-grid cell. Missing details remain REVIEW. Existing six review cases must not be approved implicitly.
- Original archive is flushed and verified before any metadata patch. The row enters PENDING before adoption. Adoption uses GET, PATCH with If-Match, then GET verification. It never POSTs a new event, deletes an event or moves its interval. The exact original description is also retained as private `crmLegacyDescription`; unrelated private/shared properties, color and reminders remain intact.
- A lost PATCH response replays against the original staged snapshot and verifies the managed identity and preserved description. Reconciliation then uses a stable `migration_<Calendar ID>` operation in the existing journal, writes Sheet projection and commits accepted state last. Existing external IDs cannot be recreated by the Calendar adapter.
- For **all external Calendar IDs** (`ext_`), an absent quote stays absent, with blank receivable and explicit price review. Ordinary newly created Sheet bookings retain their existing quoting behavior. No payment rows are inferred or written by migration. Explicit quote approval remains a separate operation.

## Required live sequence

1. Restore signed-in Apps Script access. Install `scripts/legacy-test-handover.gs` as a separate helper file only in the previously identified old TEST project; do not replace legacy source. First run `legacyTestAudit` only. It checks actual CALENDAR_ID/SPREADSHEET_ID against that project's pre-existing TEST constants, workbook/calendar TEST names, Moscow zones, Calendar owner role, checkpoint binding, absence of production approval, every installed trigger and pending legacy transactions. It does not log tokens/full property values. If any condition fails, stop before mutation.
2. Inspect time-trigger cadence in UI and preserve it privately for rollback. Confirm no other project writes the same TEST targets. Run `legacyStopTestBookingWriters` only after audit passes: shared lock, durable trigger archive, BIDIR_PAUSED=true, remove only bdOnSheetEdit/bdOnCalendarChange/bdTimer/syncCalendarToSheet triggers. Existing legacy pollTelegram is retained; no new Telegram handler is installed or called. Verify trigger list and no in-flight booking execution. Production is untouched.
3. Record the returned stopped-writer handover privately in v2 `CRM_V2_LEGACY_HANDOVER`, with `spreadsheetId` set to the v2 TEST workbook and the old source retained as `legacySpreadsheetId`. It also contains mode TEST, stopped=true, scriptId, calendarId and at. This is operator-entered evidence, not cross-project automatic discovery. Do not set it based solely on repository constants.
4. Install the newly tested v2 package, retaining the existing TEST binding and all Telegram/recurrence/payment flags off. Configure a private owner-only backup folder, enable TEST backup, run `crmV2BackupTest` and `crmV2VerifyBackupTest`. Require fresh post-handover backup and inspect the returned counts/checksum verification. Do not reuse a pre-handover same-day backup.
5. Set `CRM_V2_MIGRATION_TEST_ENABLED=true` and run `crmV2StageLegacyTest`. Verify counts, all 69 original event IDs/descriptions and untouched runtime/payment tables. This imports raw evidence into review staging only; it does not make 69 confirmed rentals.
6. Cross-check the private 55-row source mapping. Approve only exact event-ID correspondences with explicitly verified tenant/format/direction. Ten normalized +30 corrections can retain their known Calendar IDs, but do not supply missing business details. All disputed rows stay REVIEW, occupied in Calendar. No source-only record is auto-created and no calendar-only event is deleted.
7. Enable TEST writes only for reviewed import. Run `crmV2ImportReviewedLegacyTest` in batches of at most five; inspect PENDING/DONE and existing sync journal after each batch. Repeat to prove stable ID/count and no ledger change. A conflict remains held; do not force DONE or rewrite the archived snapshot. Run quote approval only when separately justified.
8. Live E2E uses explicitly labeled synthetic tenant/bookings in a verified free TEST interval. Cover Sheet create → Calendar, Calendar move → Sheet, cancel, identical retry, interruption after write, overlap rejection, no-op pass and unchanged original-event fingerprint. For financial scenarios use only separately labeled synthetic fixtures with explicit test amounts; never apply test payments to migrated customer records. Preserve evidence and clean up only synthetic fixtures. Telegram stays off. Record actual PASS/FAIL evidence; mocked CI is not live E2E.

## Recovery

PENDING retains immutable source JSON and reviewed booking JSON. Reinvoke the same entry point; do not regenerate event/booking IDs. A 412, changed source, conflicting accepted/Sheet state, unsupported recurrence or unresolved overlap requires review. On failure disable v2 write/migration flags and preserve archive, journal and actual receipts. Never restart the legacy TEST writer while v2 can write. Restore rehearsal uses fresh isolated targets, not the original production system.

## Validation

237 deterministic tests pass locally (0 failed/skipped), including 10 new migration tests: exact marker admission, automatic-intake refusal, preservation, lost-response replay, stale data/412 rejection, missing details, archive corruption and handover/backup gates. The installation build succeeds with 25 v2 modules and legacy helpers excluded. All root GAS files plus the separate legacy helper pass Node syntax checking; git diff --check is clean. GitHub CI and live execution must be recorded separately after publication/deployment.
