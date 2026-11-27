# CRM v2 — manual intake, payments, settings (2026-11-24)

Implemented in draft PR #2:
- CrmIntake.gs: normalize name and resolve unique tenant; inherit direction, format, manual regular flag; explicit direction/format override; quote by configured tariff; review for ambiguous/unknown tenants or invalid/out-of-range quote. Supports plain Calendar title or "Name — Direction"; preserves original event ID and ETag in the plan. Manual row without ID can be claimed with stable caller-supplied ID, guarded re-read, default fields and replay detection after lost response. No automatic Calendar adoption yet.
- CrmPayments.gs: persisted append-only receipt/refund adapter for Оплаты, integer kopecks internally / rubles displayed, stable payment ID, retry after ambiguous flush, strict header/formula/duplicate checks, no silent excess refund.
- CrmSettings.gs: reads existing native TEST Settings layout; validates labels, rubles/hour, periods, discount precision, environment and Moscow timezone; no silent fallback to default rates.
- crm_intake_payments.test.mjs: mocked intake, manual row claim, ledger and settings. Tests do not prove deployed behavior.

Owner explicitly permits changing the old system. This removes the prior blanket preservation constraint on implementation; no destructive edits, migration, or activation performed at this checkpoint. Preserve historical finance data, back up before migration, inspect dependencies, and prevent two active writers. Treat permission as authorization for safe changes, not evidence of tested production readiness.

Open: runtime wiring and durable operation IDs before claim/adoption, human-readable managed Calendar title edits, unresolved booking handling and occupancy union (plans carry occupied interval but do not yet enforce it), tenant ID assignment, ledger access control and strict protection, tariff version history/quote snapshot and financial projection, Calendar event adoption mapping, token/cursor, actual trigger activation, live integration. Current connector cannot deploy Apps Script or create calendar. Do not use old v1 writer simultaneously. Telegram token rotation and live owner test remain open.

Evidence:
- ea7e79331dabf80149fc3151fc71be94572561b8: [CI PASS](https://github.com/Dannymor94/tg_bot_prostranstvo/actions/runs/45484748324).
- 8e23003c65a1df63afeea487789acbfaf3df5919: [CI PASS](https://github.com/Dannymor94/tg_bot_prostranstvo/actions/runs/45484821666).
- c0d69a1488121d34e1968306f756afe9a551ebda: settings adapter and tests, final CI checked separately in PR.
