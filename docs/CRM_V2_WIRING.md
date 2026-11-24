# CRM v2 — intake and finance wiring (2026-11-25)

## Implemented
- CrmIntakeRuntime.gs connects manual Sheet intake to the TEST loop. A known tenant row receives a stable ID, default format/direction and initial quote together in one guarded write. Subsequent passes skip claimed rows. Unclaimed complete time intervals reserve occupancy; incomplete rows with no full interval remain drafts; invalid complete intervals fail closed.
- Calendar adoption supports ordinary single events for uniquely known tenants, with no existing description, attendees or recurrence. Original event ID is preserved using reversible ext_ booking ID namespace; only metadata is patched with If-Match, no event creation or movement during adoption. Existing notes, unsupported IDs, recurring/all-day and ambiguous events require review. Imported IDs cannot be recreated by the Calendar adapter if missing.
- CrmFinanceProjection.gs derives paid amount from ledger, initial quote from validated settings, preserves stored quote and actual receipts across subsequent revisions and flags price review. Cancelled bookings have no outstanding balance but retain payments. Column N currently stores the quote revision (not the latest booking revision); accepted-state sheet remains authoritative for booking revision. No automatic reprice for moves; review balance is blank pending resolution.
- CrmGasV2.gs manually invoked TEST loop now performs Calendar/Sheet intake, managed reconciliation and financial projection. Report degrades on unresolved entries or finance review. No triggers or deployment activated.
- New tests cover claim/quote, unresolved occupancy, Calendar adoption and replay, preserved notes, conditional patch, initial price, receipts and cancellation. CI tracked against code commit 9c00db6f6e6f690d7d9249b66ca6282fad814ddd.

## Remaining
- Automatic tenant ID assignment for newly entered tenant rows; currently directory must already contain valid IDs.
- Human-readable edits to managed Calendar titles and payment intent from all three interfaces; current title changes fail closed. Payment projection reads ledger, not a live payment checkbox. Price review approval flow and tariff-version history, strict protection and authorization remain.
- Intake/finance work uses conservative bounded scans. Real quota/load and manual UI concurrent edits require live tests. Cross-service atomicity is not guaranteed. Full scan and rotating managed scan remain TEST-only.
- Existing calendar descriptions are not overwritten; recurring/all-day imports need an explicit migration policy. Unknown tenants and conflicts are not auto-resolved. A review balance is excluded from the dashboard outstanding total; dashboard must expose review count before production.
- Fresh TEST GAS/calendar and actual trigger activation, three-origin end-to-end, Telegram admin/search, recurring rules, backup/restore, legacy migration. No live deployment tool available in current connector; no old data or production changes.
