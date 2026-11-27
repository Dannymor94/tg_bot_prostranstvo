# CRM v2 — billing categories (2026-11-25)

## Delivered
- Distinguish ordinary paid, regular paid and internal non-billable tenants. Compatibility with legacy boolean regular flag; new TEST directory D column is Категория with a three-value dropdown. No second category or schedule engine.
- Internal quote validates the same date, hours and format as paid quotes, returns zero total without applying a 100% discount. Reserved internal: prefix records the non-billable snapshot in the existing tariff-version field; ordinary configured tariff versions cannot use it. Financial projection displays non-billable status and zero balance for an accepted internal booking, preserves snapshot if the profile category changes later. New receipt on a zero quote is rejected; existing receipts are never silently deleted.
- Telegram onboarding, tenant cards, manual booking intake and administrator quotes recognize the category. Confirmation rechecks quote and version; initial confirmed quote persisted in row. No real customer records or production changes.
- Native separate TEST spreadsheet updated: Арендаторы!D1:D1000. Replaced boolean checkbox with strict dropdown Обычный/Постоянный/Внутренний; verified empty directory before clearing 999 auto-generated unchecked values, then verified header and validation at start and end, and blank data range. No actual tenant data was imported. Visual review limited to API metadata.
- Code/test commit 310f77dbf7f246820255d1f3040e158afdd574b0: [CI success, 197 passed, 0 failed](https://github.com/Dannymor94/tg_bot_prostranstvo/actions/runs/45555377486).

## Remaining release gates
1. Minimal recurring schedule (weekly rules, explicit confirmation, stable occurrence IDs, skip existing bookings, no automatic resurrection of cancellations, conflict review); owner-confirmed classifications supplied privately, verify precise half-hour boundaries and tenant defaults during migration.
2. Three-origin payment intent and managed Calendar title edits; approved price review and visible unresolved counts. Existing tenant editing can remain Sheet-based for MVP, Telegram editing optional.
3. Operational readiness: protect financial/technical fields, authorized writers, actionable conflict/status, bounded processing and backup/restore with tested recovery. No scope expansion beyond actual workflows.
4. Deploy fresh isolated TEST GAS and Calendar; token rotation/owner verification, actual triggers, live E2E from all three entry points, migration rehearsal, preserve historical finances, single active writer, then production cutover with owner approval.

Limitations: stored quote category is represented by tariff version namespace, not a new column. A zero-price booking with subsequent changes may need price review under existing rules; no fabricated receipt. Category change does not silently reprice existing bookings. Initial Calendar-origin price projection and tariff history still need integration acceptance. No direct GAS deployment connector available; manual deployment action remains unless a supported deployment route becomes available. Do not claim CI proves live integration. No personal names or live source IDs in repository.
