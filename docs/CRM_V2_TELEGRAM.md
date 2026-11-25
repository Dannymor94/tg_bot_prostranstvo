# CRM v2 — Telegram read-only interface (2026-11-25)

## Delivered
- CrmTelegramQuery.gs: deterministic Russian date/period/duration/range parser, civil Moscow dates, next calendar week, 120-day horizon, ambiguous input rejected. Examples: "ближайшее воскресенье", "завтра утром на 2 часа", "сколько стоит суббота с 12 до 14". Exact intervals show public price for one or both formats; regular discounts remain private. No booking side effects.
- Availability uses Calendar freeBusy for the whole day plus current and accepted CRM intervals, unresolved journal and complete unclaimed Sheet rows. No tenant details in public output. If service/inventory read fails, no confirmed availability claim.
- CrmTelegram.gs: private-chat actor identity checked on every restricted action; owner and admin allowlist; read-only admin schedule, today's payment entries, tenant directory, owner status. The Add booking menu explicitly says writing is not yet enabled. No financial mutation from Telegram yet.
- CrmTelegramPoll.gs: manual opt-in TEST polling, reusing existing sanitized transport and durable reply outbox in Code.gs. Separate GAS, dedicated TEST bot token, no legacy trigger, explicit owner and enable flag. The same bot must not be polled by two projects. Outbound delivery is at-least-once on ambiguous send; no booking side effects.
- crm_telegram.test.mjs: parser, pricing, period clipping, availability union, fail-closed responses, actor/role checks, stale status. Tests are mocked, not live Telegram/GAS.
 
## Deployment prerequisites
Include v2 modules plus existing Code.gs transport helpers (do not install legacy triggers), manifest with Calendar advanced service. Run crmV2Preflight against dedicated v2 TEST spreadsheet/calendar. Set CRM_V2_TEST_TELEGRAM_TOKEN in Script Properties only, OWNER_CHAT_ID to verified private Telegram user ID, optional CRM_V2_ADMIN_IDS comma-separated numeric IDs, CRM_V2_TELEGRAM_TEST_ENABLED=true after authorization. Run crmTgPollTest manually. Old exposed token must be revoked through BotFather. Do not publish secrets/target IDs. No actual message sent or trigger installed in this checkpoint.

## Next
Durable confirmed admin commands for create/move/cancel and payment, actor/revision/expiry binding, availability recheck, price review and idempotency. Tenant ID assignment, Calendar title editing, regular schedule, strict protections, backup/restore and legacy migration remain. Need native GAS deployment and live E2E. Manual TEST polling not a deployed service; no data or production changes.

Code/test commit eb254f6707dd9a6794631a95c646790be86ae109; CI evidence tracked in PR #2.
