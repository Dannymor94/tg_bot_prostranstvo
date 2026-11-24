# CRM v2 — storage and synchronization checkpoint (2026-11-24)

## Implemented
- CrmSync.gs: canonical three-way intent, explicit verified calendar deletion, stable operation identity, journal-before-write, comparison against expected/desired snapshots, accepted state last, reread after each write, replay and conflict freeze. This is a coordinator with injected ports, not the deployed bridge.
- CrmJournal.gs: persistent Sheets journal adapter, strict schema and no formulas, duplicate-ID detection, pending-to-done/conflict transitions, flush/readback. Requires a bound TEST target and shared lock supplied by the caller.
- crm_sync.test.mjs and crm_journal.test.mjs: simulated create from Sheets/Calendar, move/merge, cancellation, failures before and after each target write, checkpoint failure, conflicting edits, journal restart/corruption. Telegram create was not executed; a test title mentioning Telegram does not constitute a Telegram integration test.
- CI on code HEAD efa7e45b6b491af2c046a0b11af7bc4c24308183: [run 45477581876](https://github.com/Dannymor94/tg_bot_prostranstvo/actions/runs/45477581876) success.

## Native TEST spreadsheet provisioned
A separate, empty native Google Sheets CRM was provisioned directly after XLSX conversion failed. Its private link is provided to the owner separately; no target ID in public code.
Locale ru_RU, time zone Europe/Moscow. Five visible sheets: Главная, Аренды, Арендаторы, Оплаты, Настройки. Hidden: _CRM_JOURNAL and _CRM_ACCEPTED. Headers and tariff seed verified by connector readback; dashboard formulas corrected for locale, empty-state values 0/0/0 verified. Filters, frozen rows, widths, validation and warning-only protections were applied; strict protection and visual inspection remain open. No real customer data, events or payments were imported. No v2 GAS project or triggers activated.
 
### Layout contract (prototype)
- Аренды A:Q: Дата, Начало, Конец, Арендатор, Направление, Формат, Стоимость, ₽, Получено, ₽, Остаток, ₽, Статус, Действие с оплатой, ID аренды, ID Calendar, Ревизия, Версия тарифа, Синхронизация, ID арендатора. L:Q hidden; G:I system-derived once wired. Payment action is an intent only; ledger is canonical.
- Арендаторы A:H: Имя, Направление, Формат, Постоянный, Контакт, Регулярное расписание, Примечание, ID арендатора.
- Оплаты A:H: Дата платежа, ID аренды, Арендатор, Операция, Сумма, ₽, Источник, Ответственный, ID платежа. Persist amount in kopecks internally; display rubles, never confuse units.
- Настройки A:C: version, effective date, open, morning end, day end, close, regular discount, time zone, TEST mode (rows 2–10); E:I four rate rows in rubles/hour (rows 2–5). Seed only; validated adapter and version history still required.
- _CRM_JOURNAL A:E: Operation ID, Booking ID, Status, Intent JSON, Reason. Prefix IDs op: / booking:. Limit 20,000 records; retention/archival and capacity alert remain to be implemented before production.
- _CRM_ACCEPTED A:C: Booking ID, Revision, Accepted JSON. Header only; implementation pending. Visible data grid initially 999 data rows, no automatic extension yet.

## Next gates
1. Implement bound Sheets booking/payment/accepted-state adapters with stable IDs, strict header validation, formula/format preservation, revisions and tests for sorting, missing rows and edited technical fields. Add capacity and explicit conflict-resolution controls. Resolve Sheets/Calendar races by reread and quarantine; no unconditional last-write-wins.
2. Implement actual Calendar REST adapter with stable IDs, verified absence, ETag preconditions, sync token pagination and 410 recovery. Calendar event contents private. Price review and ledger are separate from booking snapshot synchronization; coordinator alone does not persist financial projections.
3. Wire only to a fresh test GAS and calendar after code tests; verify UI edits and crash recovery with real services. Do not run both writers on one calendar or sheet. Test token rotation/owner chat still open.
4. Remaining CRM-04+ Telegram, recurrence, reporting, backup/restore and legacy finance dependency audit. No deployment or main merge.
