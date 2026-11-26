# CRM v2 — owner-approved business rules and DEV-2 delivery plan

Approved by owner in CRM brief, 2026-11-26. This decision record supersedes conflicting defaults in earlier design notes. It is not evidence that new behavior has already been implemented or deployed.

## Business decisions (all approved)
1. Regular tenant discount: suggest regular classification automatically; administrator must confirm. Existing 10% discount, explicit tenant category and historic quote snapshots remain. No automatic discount/category mutation. The previously documented poster threshold (>10 hours/month) is a candidate for the suggestion policy; exact eligible hours/window and handling of cancellations require a defined contract before implementation. Internal bookings remain non-billable.
2. Allow payments before and after the rental, including partial receipts. Preserve immutable ledger and idempotent settlement; no inferred payments.
3. Display outstanding balances/debt without blocking new bookings. Do not equate every future unpaid booking with overdue debt.
4. Cancellation: no automatic penalty. Administrator decides the financial outcome; retain receipt history, never automatically refund or fabricate a receipt.
5. Reschedule: recalculate quote for the new interval and retain all actual receipts. Preview changed amount when possible; external edits require safe validation and conflict handling. No silent repricing of historical completed rentals; overpayment remains visible for administrator resolution, not an automatic refund.
6. Recurrence: rolling one-month forward horizon with automatic extension. Existing 30-day future rolling implementation is the initial engineering interpretation; preserve occurrence identity, exceptions and cancellations. No unapproved production rules.
7. Notify administrator of new rentals, cancellations, debts and technical failures. No tenant notifications by default. Deduplicate notices and avoid repeated debt alerts; define delivery cadence and overdue threshold before enabling live notices.
8. Migrate historical/imported booking amounts and payments from the old financial workbook after reconciliation. Read only the private source copy; match verified booking identity, distinguish quoted amounts from actual receipts and preserve dates/amounts/source evidence. Ambiguous values remain in review; never infer a receipt from a tariff or booking. No writes to the original system.

## Execution plan
- DEV-03: deploy corrected CRM v2 package to the existing isolated TEST GAS only; use the last green code including the Calendar ID projection fix 1da1c5c4066ca50498d17c8389c96f6255eb8ade. Verify actual binding, readback and disabled flags; do not reimport the 50 completed rows, change the 19 REVIEW rows, or touch Calendar/financial records. No activation.
- DEV-04: inspect existing finance/quote paths and implement only confirmed gaps (reschedule repricing, suggested discount, debt projection and reconciliation contracts); run focused synthetic finance acceptance. Read-only mapping of historical finance source, then separate reviewed import using evidence, backup and idempotent ledger. Never use real bookings as test fixtures.
- DEV-05: authorize dedicated Telegram integration separately, verify private actor IDs and rotated token entered directly in GAS, single bot consumer; confirm admin and public flows, payment and notification behavior. No public private data.
- DEV-06: verify rolling recurrence, bounded automatic reconciliation/notification jobs, single writer, quotas, actionable status and backups in TEST. No activation without the relevant acceptance and explicit authorization.
- DEV-07: verify isolated Calendar/state recovery, migration diff and operational checklist; production switch only with owner approval. Preserve historical systems and records, no merge/production writes without approval.

## Operating policy
AGENTS.md governs execution. Primary developer does all directly available GitHub/Sheets/Calendar work; delegate only operations unavailable in current tools, with precise English scope. No routine independent QA or architecture consultation absent a concrete risk. Reuse verified evidence, no repeated import/checks without a new defect. Existing CI 244/244 and live reviewed TEST booking import are prior evidence, not proof of finance or Telegram live acceptance.

Current constraints: GAS browser deployment is not supported by the ordinary connected tools. Use an authorized Work browser session for DEV-03. No tokens, personal contact data, private target IDs or customer data in public GitHub. All flags remain off until separately approved test steps.
