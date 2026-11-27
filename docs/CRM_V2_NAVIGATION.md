# CRM v2 — admin navigation and tenant onboarding (2026-11-25)

Implemented:
- CrmTelegramNav.gs: actor-local 15-minute navigation, paginated tenant lists and booking lists by date, booking cards, full/partial payment, move/cancel, tenant creation. Select tenant and type the exact interval; no exposed booking ID needed in normal navigation. Callback tokens refer to server-side choices; stale selections are rejected by token and booking revision. Mutations still use the existing durable confirmation flow. Commands remain available as a fallback.
- CrmTenants.gs: confirmed tenant creation, stable ID, duplicate normalized name guard including unclaimed manual rows, preserved contact/note fields during automatic manual row claim. Unknown/incomplete/duplicate rows are not automatically claimed. Tenant claim is wired into the TEST reconciliation before booking intake.
- Dispatcher and handler: route buttons and text prompts, actor checks, clear navigation on menu change, durable preview replay by Telegram update ID even after navigation state clears.
- Regressions: tenant selection, date navigation, stale booking revision, guest denial, tenant creation/replay, manual claim and duplicate guard, durable text preview routing.

Limitations: tenant viewing/creation is implemented; editing existing tenant profiles through Telegram and name-change propagation remain open. New tenant details and exact booking interval still use text; no calendar-picker or complex forms. Historical dates accessible through previous-day navigation (120-day range), not historical free-text date selection. TEST flags remain required; no deployed GAS/Telegram or real data changes. Simulated tests do not prove live integration. Remaining: recurring rentals, payment actions in Sheet/Calendar, managed title edits, explicit price review, protections, conflict recovery, backup/restore, legacy migration and live acceptance.

Code/test commit 7949ac687e0cace2e7e9cce5550acbe15e44130d. CI evidence tracked in PR #2.
