# Install CRM v2 in an isolated TEST environment

Do not edit the existing financial workbook, original Calendar, or old Apps Script project. Do not run copied bound legacy scripts. The CI artifact crm-v2-test-install contains CrmV2.gs, appsscript.json, this guide and BUILD.json (source commit and SHA-256 hashes). Use a new standalone Apps Script project.

## Setup (manual Google authorization is required)
1. Create a separate empty owned Google Calendar with time zone Europe/Moscow and title starting "ТЕСТ — " and containing "CRM v2". Use the prepared private v2 TEST workbook (title begins "ТЕСТ — Пространство йоги — Mini CRM v2"), not the copied historical workbook. Both IDs must be distinct from all legacy IDs.
2. Open script.google.com and create a new standalone project. Paste CrmV2.gs as the only source (remove default myFunction). Enable display of appsscript.json in Project Settings, replace manifest with supplied file. Advanced Calendar service v3 must be enabled. No old Code.gs/Bidirectional.gs or legacy triggers.
3. Project Settings → Script properties: CRM_V2_BINDING = {"mode":"TEST","spreadsheetId":"NEW_SHEET_ID","calendarId":"NEW_CALENDAR_ID"}. Run crmV2Preflight; authorize Google access. Require correct binding, schema, timezone, zero unexpected errors. OAuth scopes allow Google Sheets, Calendar, Drive, external HTTP, and script trigger management; isolation is enforced by target checks, not by scoped resource tokens.
4. Use a dedicated new Telegram test bot (BotFather). Revoke any previously exposed token; enter token directly in CRM_V2_TEST_TELEGRAM_TOKEN. Set OWNER_CHAT_ID to verified private numeric chat ID; optional CRM_V2_ADMIN_IDS is comma-separated verified numeric IDs. Do not share secrets in chats or GitHub.
5. Keep all mutation flags absent initially. On TEST targets only, set CRM_V2_TEST_WRITE_ENABLED=true; run crmV2ReconcileTest manually. After successful fake booking tests, enable CRM_V2_TELEGRAM_TEST_ENABLED and CRM_V2_TELEGRAM_WRITE_ENABLED, run crmTgPollTest. Enable CRM_V2_RECURRING_TEST_ENABLED and CRM_V2_PAYMENT_INTENTS_TEST_ENABLED separately only after basic tests. Use a private backup folder with CRM_V2_BACKUP_FOLDER_ID and CRM_V2_BACKUP_TEST_ENABLED. Run crmV2BackupTest and crmV2VerifyBackupTest; set CRM_V2_RESTORE_TEST_ENABLED for isolated workbook restore rehearsal.
6. Verify create/move/cancel, partial/full payment from all supported origins, internal/regular pricing, repeats and conflict recovery. Do not activate triggers or production until these pass; automatic trigger installation is not part of this package yet.

## Migration
Read only from the separate private legacy workbook copy. Keep all historical financial tabs and original values intact. Reconcile exact intervals, tenant identities, direction/format and payment evidence; never infer paid from a booking or approximate +30 marker. Import confirmed future rentals only after checking against the new Calendar and validating the draft rows. Unresolved records need review, not a fabricated quote or receipt. Old data remain unchanged. At cutover select the new workflow for future bookings, avoiding double-entry. Preserve both sources and make a fresh migration diff.

## Rollback
Disable TEST flags and delete only triggers created in the isolated project, if any. Retain new receipts and archives. Never modify or delete the original spreadsheet or Calendar. Do not promote this TEST-bound code to production merely by changing titles; production needs explicit owner approval and environment validation.

## Limitations
No automated GAS deployment connector is available in this workflow. Live Google authorization, Calendar creation, trigger activation, strict protection verification and Calendar restore acceptance remain required. The build is a TEST installation bundle, not proof of live service availability.
