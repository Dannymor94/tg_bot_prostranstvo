# CRM v2 — confirmed Telegram admin operations (2026-11-25)

## Delivered
- CrmTelegramAdmin.gs: /add NAME | DATE TIME, /move ID | DATE TIME, /cancel ID, /pay ID | AMOUNT or полностью. Known tenants only, exact time required; menu shows command examples, schedule shows booking IDs.
- Private chat actor/role checked at dispatcher and locked mutation handler. Preview is durable, tied to Telegram update ID and actor; expires after 15 minutes. Confirm/abort callbacks use stable command tokens; confirmation rechecks accepted revision, current projections, occupancy, price, and payment balance where applicable.
- Command state persisted before any mutation; started commands are retained, replay uses same booking/operation/payment ID. Existing synchronization journal and payment ledger are reused. Create stores initial quoted price and version in the same Sheet row write; moves preserve the old quote and flag review, cancellations preserve payment history. No refund is initiated by cancellation.
- Test-only mutation requires both CRM_V2_TEST_WRITE_ENABLED and CRM_V2_TELEGRAM_WRITE_ENABLED, plus the existing separate TEST binding and dedicated bot configuration. No trigger or deployment performed.
- crm_telegram_admin.test.mjs: create/move/cancel, stale and cross-actor confirmation, changed occupancy/tariff, partial and remaining payment, replay after lost response. Mocked tests, not live GAS/Telegram.

## Remaining and limitations
- UI is command-based, not final button-driven booking/tenant/payment navigation. IDs are shown in today's schedule; lookup of other dates and tenant creation still need implementation.
- Explicit reprice approval, Calendar title changes, Sheet/Calendar payment intent, tenant ID assignment, regular rentals, protections, conflict recovery, dashboard review counts and backup/migration remain.
- Command storage uses Script Properties with a 100-record cap; terminal records older than seven days can be removed on a new command, started records are never automatically deleted. Need a production retention/capacity policy and operator recovery for abandoned started operations. Confirmation replay is safe by stable ID, not exactly-once delivery of Telegram replies.
- External UI edits bypass ScriptLock; guard reads and existing journal limit risk, not a cross-service transaction. Strict protections and live concurrency/restore tests still required.
- No GAS deployment or trigger installation capability in current connector. No old-system or production change. Bot token rotation and owner private chat verification remain prerequisites.

Evidence: initial command tests commit 8443862f61f0e56d2d3eaf7ed213bfe4d84e2cb3, CI 45547141834 success. Final code/test commit 0ab6622e83a6b98e8ed14590fd92a925d364a6ec adds quote persistence; see PR #2 for final CI.
