# CRM v2 — managed reconciliation runtime (2026-11-24)

## Implemented
- CrmRuntime.gs composes the existing managed Sheet/Calendar/accepted/journal adapters, resumes durable pending operations first, freezes unresolved conflicts, and skips unchanged records. Full inventory scan with a rotating bounded ID scan; intentionally no delta cursor publication yet.
- Availability conservatively includes current CRM records, accepted intervals, all unresolved journal ranges, and live overlapping Calendar events (expanded recurrence, all-day events, all pages). Only the precisely identified managed event is excluded. Incomplete or failed reads do not imply free time.
- CrmJournal.gs exposes records for replay.
- CrmGasV2.gs provides read-only crmV2Preflight and manually invoked crmV2ReconcileTest, requiring explicit separate TEST binding and write flag, correct named TEST targets, owner Calendar access, Moscow timezone, no v1 binding/triggers, and ScriptLock. No trigger installer or deployed change.
- crm_runtime.test.mjs exercises managed create/move/cancel, replay, bounded scan, overlap and failures with simulated ports. Live API/GAS execution is NOT yet verified.

## TEST setup (not a production installation)
Use a separate Apps Script project and only v2 modules, with Calendar API v3 advanced service enabled. Set Script Properties CRM_V2_BINDING to JSON with mode TEST, spreadsheetId and calendarId; no IDs or secrets in repository. Use the existing dedicated v2 TEST spreadsheet and a newly created dedicated TEST calendar named 'ТЕСТ — ... CRM v2', timezone Europe/Moscow. Run crmV2Preflight first. CRM_V2_TEST_WRITE_ENABLED is false unless explicitly set to true after readiness checks. crmV2ReconcileTest is manual, limited to 10 records/pass; CRM_V2_SCAN_AFTER rotates the scan. No v1 writer may share these targets.

## Remaining gates
Runtime handles already-managed records only. Manual row ID allocation/claim journal, tenant ID creation, Calendar adoption/mapping and title edits must be wired before normal user entry is supported. Unmanaged Calendar events block overlapping time; unclaimed Sheet rows currently fail inventory rather than be ignored. Payment ledger and pricing are not yet wired into financial projections. Strict protections, role enforcement, conflict resolution, cursor/scale strategy, backup and real end-to-end tests remain. Full inventory/per-record reads and journal rescans are conservative TEST design, not a proven production performance target; pending queue can consume pass budget. No GAS deployment or fresh calendar creation tool available. No production data, triggers, main or v1 changes.

Code/test commit 4c476d34ce2e7edd68009416c43612425d68e35f. CI evidence is tracked in PR #2.
