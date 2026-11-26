# CRM v2 — live TEST acceptance, 2026-11-26

**Booking E2E: PASS.** Completed at 2026-11-26T12:28:08.967Z (**15:28 Moscow**).
Final read-only preflight also passed. Production workflow unchanged; Telegram not connected to CRM v2.

## Installation and legacy TEST handover

- Verified the actual old project's configured spreadsheet/calendar against its exact TEST constants, native TEST titles, Moscow time zones and Calendar owner role. Checked trigger source IDs and absence of production approval; pending legacy transactions: 0.
- Legacy BD_TARGET_BINDING was absent. The first audit stopped before mutation. Inspection of the legacy guard confirmed that this is supported for its exact TEST constants; the helper now allows absence only with those exact TEST checks, rejects any mismatched nonempty binding, and still rejects production approval. Regression tests cover this boundary.
- Inspected all 10 installable triggers visible to the connected account: the only booking synchronization triggers were in the identified old TEST project. Its timer was every 12 hours.
- Added a separate audit/handover file; existing legacy function bodies were not replaced. Under the old project's ScriptLock, archived the trigger inventory privately, set BIDIR_PAUSED=true and removed exactly bdOnSheetEdit, bdOnCalendarChange and bdTimer. The obsolete syncCalendarToSheet trigger was not installed. Verified the remaining list contains only the existing pollTelegram. That legacy read-only consumer was neither connected to v2 nor changed.
- Installed the 25-module v2 package from code commit 4749fd6306405dfba1a0dc4bbd2a5236b2d65603. Read back the entire installed source and compared it with the assembled commit sources.
- Installed the separate synthetic acceptance script (final source change 0ca68d1b5e17557090d48fc09cf2dcb1b6516294). Private operator wrappers recorded the already observed handover, configured backup and enabled manual synthetic testing; they contain private target bindings and are not published here.

## Verified backup and real-event archive

- Created a new owner-only private backup folder and a fresh post-handover backup. The native workbook copy, Calendar/operational-state payload and manifest were verified with the existing checksum/shape checks.
- Backup report: ok=true, reused=false, date=2026-11-26, Calendar objects=75. Independent backup verification: ok=true, 75 objects, operational entries=0. This includes cancelled REST objects; the normal event listing has 69 current events.
- Ran crmV2StageLegacyTest against the approved TEST targets: staged=69, existing=0, review=69. All 69 source Calendar IDs and complete original event JSON are retained in the hidden private _CRM_MIGRATION archive. Every original description exactly matches the supported STUDIO_BIDIR_V1 description.
- Independent Sheets readback: 69 rows, 69 unique IDs, every status REVIEW, zero reviewed booking JSON values. No real customer row was added to Аренды or Оплаты.
- Repeated staging after E2E: staged=0, existing=69, review=0. Here review=0 means no *new* review rows; the existing 69 rows remain REVIEW.
- The existing 55-candidate import and private comparison tab are preserved. Ten +30 extraction corrections remain recorded separately from raw grid times. The six individual discrepancy entries remain held.
- Full confirmed customer migration is intentionally incomplete: verified format/direction/tenant details are missing. The archive is not an authorization to invent those values, quotes or payments. Existing Calendar occupancy remains authoritative for these held events.

## Live synthetic booking scenarios

| Scenario | Observed result |
| --- | --- |
| Sheet-origin create | One Calendar event; accepted revision 1 |
| Calendar-origin move | Sheet synchronized to the moved interval; revision 2; same Calendar ID |
| Overlap protection | A distinct candidate in the moved occupied interval was unavailable |
| Exact legacy-marker adoption | A second synthetic legacy event was adopted without changing its Calendar ID or interval |
| Lost PATCH response | Real metadata PATCH succeeded; transport deliberately threw before returning it; retry read the real event and recovered |
| Adoption replay | Same original staged snapshot replayed successfully without another event |
| Imported quote policy | Price and receivable stayed blank pending explicit review |
| Calendar-origin cancellation | Both synthetic events cancelled; both Sheet/accepted records became cancelled |
| Two no-op replay passes | Stable cancellation intents returned done; journal count unchanged |
| Original-event integrity | Full original Calendar-object fingerprint unchanged after excluding the two synthetic IDs |
| Payment integrity | Ledger fingerprint unchanged; no receipts/refunds created |

Final live report persisted privately in CRM_V2_LIVE_ACCEPTANCE_REPORT:
```json
{"status":"PASS","create":true,"calendarMove":true,"overlapRejected":true,"legacyIdPreserved":true,"legacyReplay":true,"lostPatchResponseRecovered":true,"cancelledFixtures":2,"noOpReplays":2,"originalCalendarUnchanged":true,"paymentsUnchanged":true,"endedAt":"2026-11-26T12:28:08.967Z"}
```

This is booking synchronization/adoption acceptance. Telegram, actual payment entry, production load/quotas and full Calendar restore were not exercised.

## Independent final readback and safe end state

- Calendar connector, complete bounded listing: exactly 69 current events, no next page, zero active synthetic events. For every archived original ID, title, start, end, description and color match the original archive.
- Аренды: exactly two synthetic rows, both Отменена; all cost/received/balance cells blank. These cancelled fixtures and their audit history are retained, not real customer bookings.
- Оплаты: zero data rows.
- _CRM_JOURNAL: five records, all done. No pending/conflict operation.
- Final crmV2Preflight: mode=TEST, managed=2, unmanaged=69, tenants=1, unclaimed=0, payments=0, pending=0, conflicts=0, writeEnabled=false. The two managed records and one tenant are synthetic test fixtures.
- The final verification disabled CRM_V2_TEST_WRITE_ENABLED and CRM_V2_LIVE_ACCEPTANCE_ENABLED. v2 trigger UI confirms zero triggers. No recurring or payment-intent writer enabled; no Telegram token/consumer configured in v2.
- Only the old TEST booking writers are stopped. No original production workbook, calendar, script, trigger or main branch was changed.

## Reproducibility and checks

- Source: scripts/crm-live-acceptance.gs; legacy boundary tests: crm_legacy_handover.test.mjs.
- Local deterministic suite: **242 passed, 0 failed/skipped**. Standalone script syntax checks pass.
- GitHub CI at code/test head 6f462894e34631e46e6666e3a5d908accb37ecb9: success, [run 45819546661](https://github.com/Dannymor94/tg_bot_prostranstvo/actions/runs/45819546661).
- The TEST installation build excludes legacy and live-acceptance helper scripts. The normal v2 package includes 25 modules.
- Keep production and automatic TEST writes disabled until the remaining customer details/discrepancy review is completed. Do not resume the old TEST writer while v2 can write; retain the private backup, trigger archive, migration archive and journal.
