# CRM v2 — reconciliation and cutover gate, 2026-11-26

Status: **BLOCKED for activation**. Data comparison and live v2 preflight completed; old handler inventory partly verified; mutation E2E not executed. This is a TEST handover only, not production approval. Telegram remains disabled. Original production workbook, calendar, scripts and triggers were not modified.

## Evidence and changes
- Reviewed PR head a45592874f7984aa868111efb3b8fd777de656f6. Its PR workflow run 45596042572 completed successfully. No new application code or deployment in this checkpoint.
- Fresh Calendar connector read over 2025-01-01 inclusive through 2028-01-01 exclusive, Moscow: 69 events, no next page. All returned descriptions are the legacy STUDIO_BIDIR_V1 import marker.
- Compared all 55 staged rows in the private TEST workbook against Calendar using normalized exact label plus Moscow date, then exact start/end. Baseline: 40 exact, 11 differing intervals, 4 staging-only; 1 future calendar-only. No multiple name/date matches.
- Read migration-copy booking rows 2041–2078 and the distinct old TEST workbook over the same rows. Did not write either workbook.
- Ten interval differences are explained unambiguously by the preceding 18:30 half-hour marker: migration copy, old TEST grid and Calendar agree on 18:30–20:00. Preserved raw staging grid times and recorded corrected normalized intervals separately.
- Added private review-only tab **Сверка 26.11**, A1:I57: header, all 55 source references, plus the unmatched Calendar event. Contains source reference, date/name, raw interval, Calendar interval, result, verified interval, safe next action and existing event ID. Readback verified every cell. Frozen header, filter, wrap and widths checked through API; native Google Sheets screenshot checked after sign-in: readable wrapped rows and frozen header; table exceeds viewport width and uses horizontal scrolling for the event-ID column.
- Thus 50 interval correspondences established, with 6 individual review entries (5 staging records and 1 Calendar event). This does not approve tenant format/direction, booking status, quote or payment.
- Full current allocated runtime ranges read: Аренды A1:Q1000, Оплаты A1:H1000, _CRM_ACCEPTED A1:C1000, _CRM_JOURNAL A1:E20001 contain headers only. No rental, receipt, charge or acceptance row added.

## Unresolved entries (private detail stays in TEST workbook)
| Staging row | Source reference | Issue |
| --- | --- | --- |
| 2 | 2041 I:I | No matching Calendar event; verify current booking |
| 5 | 2042 G:G | No event and trailing +30 is ambiguous; do not apply preceding-marker grammar |
| 6 | 2042 N:O | Copy says 18:00–20:00; old TEST grid and Calendar say 18:00–21:00 |
| 7 | 2042 P:P | No event that day; same label occurs next day in Calendar |
| 14 | 2046 Q:Q | No matching Calendar event; verify current booking |
| Calendar-only | separate review row 57 | Next-day event may relate to staging row 7; do not infer a move |

Keep all 69 events and reserve their occupied intervals, including unresolved entries. Never auto-delete calendar-only or recreate staging-only entries. Resolve the shared 20:00–21:00 interval and date discrepancy before importing either competing record.

## Handler audit: established versus missing
Repository Bidirectional.gs defines bdOnSheetEdit, bdOnCalendarChange, bdTimer and bdInstallTriggers; Code.gs includes the older one-way/Telegram paths. Repository TEST constants reference a distinct legacy TEST workbook and the approved reused TEST calendar. That TEST workbook exists and its grid agrees with the current Calendar differences. This is evidence of intended binding, **not proof of installed triggers, deployed source or current Script Properties**.
CrmGasV2.gs rejects legacy triggers/properties in its own project only. It cannot detect writers in another project. A clean v2 project is therefore insufficient proof of single-writer safety.
Drive script-file search returned no script projects, but browser sign-in was restored and actual project UIs inspected:
- Old project: four installed HEAD triggers: pollTelegram (time-driven), bdOnSheetEdit (spreadsheet edit), bdTimer (time-driven), bdOnCalendarChange (Calendar updated). The Calendar trigger's edit dialog explicitly contains the approved reused TEST calendar ID; canceled without saving. The Sheet trigger dialog confirms spreadsheet-edit type but does not display a source ID.
- Old trigger list showed pollTelegram last run 2026-11-26 09:15:51, bdOnSheetEdit 2026-11-20 08:16:52, bdTimer 2026-11-25 22:54:59 and bdOnCalendarChange 2026-11-25 11:16:55 (displayed UI times; not independently converted). Calendar trigger error ratio displayed 33.33%; cause not yet investigated. No syncCalendarToSheet trigger in this project's four-row list.
- Old settings have >50 properties; UI displays only the first 50 BD_API index entries read-only. Live SPREADSHEET_ID/CALENDAR_ID/WRITE_ENABLED, pending state, time-trigger cadence and writers in other projects are not yet proven. Do not infer all bindings from a single trigger.
- v2 standalone project settings contain exactly CRM_V2_BINDING (correct TEST workbook and reused TEST calendar) and CRM_V2_REUSE_TEST_CALENDAR=true. Moscow project timezone. No mutation, Telegram or recurrence flags. Its trigger list shows zero triggers.
- Successfully ran the existing read-only crmV2Preflight: mode TEST, managed 0, unmanaged 69, tenants 0, unclaimed 0, payments 0, pending 0, conflicts 0, writeEnabled false. Log shows start 09:18:17 and completion 09:18:22 in displayed UI time.
- A first run immediately after changing the function selection invoked the previously selected crmV2BackupTest; it failed at the explicit TEST backup disabled guard, before backup writes. Then crmV2Preflight was run successfully after selection settled. No flags were changed and no backup was created.
Neither old project code/properties/triggers nor v2 source/properties/triggers were changed. No writer was stopped or enabled.

## Concrete activation blockers
1. Signed-in access restored and both projects inspected. Complete the old project's remaining runtime binding/pending-state audit (UI hides properties after the first 50). Record script identity privately, target IDs, installed trigger handler/type/source/unique ID, last runs and active deployment/version. Do not expose tokens in evidence.
2. Only after verifying exact TEST targets, stop the old TEST booking writer(s); preserve their configuration and logs. Inspect the one-way syncCalendarToSheet path as well as bd* triggers. If the project also writes production or binding is uncertain, do not disable it. Do not run installers/bootstrap functions during inspection.
3. Existing descriptions block automatic adoption: crmAdoptCalendarEvent_ returns existing_description for all 69 legacy-marker events. Do not erase them globally. A dedicated migration operation must recognize the exact approved marker, preserve it in private backup/audit, bind existing ID to ext_<eventId>, preserve timing and unrelated metadata, condition writes on ETag, and verify replay. Unrecognized descriptions remain review-only. No such migration was executed.
4. Do not populate Аренды through ordinary new-row intake for an existing Calendar event: that can allocate an unrelated booking ID and collide with/create a duplicate event. Adopt and verify the existing event identity first, then materialize its matching Sheet/accepted record through the journal.
5. No financial carry-forward from names, colors, half-hour markers or event descriptions. Require explicit approved format/direction and tariff/quote policy before financial projection; payments need separate evidence and stable payment IDs. Keep payment intents and weekly generation off throughout migration.

## Ordered TEST cutover and rollback
1. Keep v2 mutation/recurrence/payment/Telegram flags false; no new triggers. Complete the live handler inventory and review decisions.
2. Freeze only the verified old TEST writer. Confirm no in-flight execution, retain its trigger inventory, then take a fresh Calendar + workbook/state backup with checksum and re-read both sources for drift.
3. Recompute the 55-row diff. Use the private source-reference-to-existing-event-ID mapping; enforce unique source reference, Calendar ID and booking ID. Import reviewed records with stable ext_ identity, journal-before-write, ETag/readback, accepted state last. Stop on drift or ambiguity. Preserve unreviewed occupancy.
4. Run the following E2E manually on dedicated synthetic fixtures in a verified free TEST interval; no Telegram. Keep real imported rows outside mutation scenarios. Do not use arbitrary existing customer bookings as test fixtures.
5. Permit a TEST scheduler only after every required scenario has recorded evidence and the old TEST writer is verified stopped. Production remains separate.
Rollback: disable v2 writers/flags first, stop any in-flight run, retain new ledger/journal entries and export current state. Reconcile changes made since backup before any old TEST writer resumes; never blindly restore an old snapshot or re-enable two writers. Restore rehearsals use fresh isolated targets. Original production objects remain untouched.

## E2E acceptance matrix (prepared, NOT executed live)
| Scenario | Required evidence |
| --- | --- |
| Read-only baseline | Exact bindings; old TEST writer stopped; Telegram/recurrence/payment flags off; checksummed backup; counts and interval/ID fingerprint |
| Existing-event migration + replay | Same Calendar ID and count; original interval/metadata retained; one Sheet row + accepted identity; second run adds nothing; no receipt/charge without approved policy |
| Synthetic Sheet create/move/cancel | One stable event ID, matching accepted state/revision; cancellation preserves ledger history |
| Calendar create/move/title edit/cancel | Known synthetic tenant, expected parsing; matching Sheet/state; unchanged unrelated events |
| Conflict/concurrency | Simultaneous incompatible edits freeze; live overlapping/unmanaged events block creation; no lost booking |
| Interruption/retry | Failure after Calendar write and before accepted checkpoint recovers to one event/row with stable IDs |
| Finance, synthetic only | Explicit test quote; partial/full payment and retry produce one receipt per intent; cancel retains actual receipts; no real financial entries |
| +30 and boundaries | 18:30 boundaries round-trip; ambiguous trailing +30 rejected; adjacent non-overlapping intervals allowed |
| Recurrence, separate fixture | Enable only for synthetic rule; repeated passes create no duplicates; collisions freeze; disable afterwards |
| Backup/restore | Verify checksums; restore workbook, Calendar and operational state into fresh targets; semantic equality and no source mutation |
| Final no-op + cleanup | Two complete passes add no event/row/receipt; fixture-only cleanup; original 69-event fingerprint preserved except explicitly approved migration metadata |

For every scenario record start/end Moscow time, installed build SHA/hash, fixture/operation IDs privately, before/after counts, journal state and observed result. Mocked CI success is not a live E2E PASS.
