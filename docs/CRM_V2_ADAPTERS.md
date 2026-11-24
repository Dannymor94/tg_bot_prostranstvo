# CRM v2 adapter checkpoint — 2026-11-24

Implementation on isolated branch, no deployed triggers or real data changes.

## Scope
- CrmSheets.gs: typed normalized date/minute display parsing, strict header/schema checks, ID-based lookup independent of row order, tenant directory resolution, guarded read/compare/write of managed booking rows, preserves existing financial fields and payment intent, rejects formulas and ambiguous tenant names. _CRM_ACCEPTED persists canonical snapshots with monotonically incremented revisions. Amounts and actual receipt ledger are not written by this adapter.
- CrmCalendar.gs: REST transport for a separately bound calendar, stable base32hex-compatible event ID for newly managed bookings, private extended booking ID, Moscow minute conversion, conditional PATCH/DELETE using If-Match, ambiguous insert readback, verified calendar access before accepting absence, rejects unsupported recurring/all-day/attendee events and manual title changes. Full/delta listing collects complete pagination and handles 410 by full read; checkpoint publication remains caller responsibility.
- crm_adapters.test.mjs: mocked Sheets and REST, sorting, preserved existing financial cells, stale snapshots, duplicate IDs, invalid tenant/formula, revision increments, create/move/delete, ambiguous insert, 412, unavailable calendar, complete paging and 410. Additional composed-port create/move/cancel test uses the persistent journal adapter against mock Sheets and mock REST. Not live E2E.

## Explicit limitations / next gate
1. Managed booking rows require assigned IDs and an existing tenant directory. New manual rows/events and human-readable calendar title parsing require ingestion adapters; do not enable reconciliation until these are implemented. Unknown title changes are blocked, not silently overwritten. Calendar title and financial intent editing are not complete. Native recurring events need an explicit import policy.
2. Sheets has no transactional CAS across user UI edits. Adapter checks values immediately before writing and verifies booking afterward; strict protections and concurrent edit tests are required before activation. No claim of complete conflict prevention. Financial ledger persistence, quote review and projection, revision enforcement for payment actions, and availability union with unprocessed calendar changes remain open.
3. Calendar pages return candidate token, not persisted state. Need durable cursor checkpoint, ingestion, deletion evidence, bounded retries, pending journal replay and actual event availability checking in runtime orchestration.
4. Fresh v2 test Apps Script and calendar required. Current connectors can manipulate events and spreadsheets but no Apps Script project deployment or trigger creation action is available. Do not activate on the original v1 test targets. Native test sheet provisioned in previous step, unchanged here. Owner rotation of Telegram token remains required before live Telegram acceptance.
5. No production deploy or main merge. See CRM_V2_PLAN.md and CRM_V2_STORAGE.md for full gates.

## Evidence
Initial adapter test commit 9ca1046cd130896ce198870f0c6f1a843ec7e76e: [CI success](https://github.com/Dannymor94/tg_bot_prostranstvo/actions/runs/45480179480).
Final adapter test commit 629ca5f555dece996aa37b889b92c4d4fd2a54db adds title quarantine and composed-port regression; see [CI run](https://github.com/Dannymor94/tg_bot_prostranstvo/actions/runs/45480301364).
