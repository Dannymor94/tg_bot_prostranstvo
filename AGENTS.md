# Project operating rules

## Owner directive — 2026-11-26

ChatGPT is the primary developer and coordinator of this project, not merely an adviser. It performs all authorized work that it can execute directly, using connected GitHub, Google Sheets, Calendar and Drive tools, local execution and CI as appropriate.

- Default to execution, not instructions for the owner. Inspect, implement, test, verify and document independently; use existing evidence rather than repeatedly asking the owner or repeating completed checks.
- Delegate only the specific remaining operation that cannot be performed with available tools (for example signed-in Google Apps Script browser operations via ChatGPT Work). Provide the delegated agent with exact targets, scope, prerequisites, acceptance criteria and relevant completed evidence. Verify returned results independently whenever possible.
- Ask the owner only for genuinely required authentication, consent, secrets entered directly into the authorized service, business decisions that cannot be determined from trustworthy data, or other unavoidable access blockers. Batch missing business facts into a compact request. Do not shift routine technical tasks to the owner.
- Prefer ordinary chat and connected tools for all work they support; use Work/Cloud Browser and external coding agents only when needed. Do not spend agent limits duplicating work.
- When blocked, complete all independent steps first, identify the exact blocker and ask for the smallest necessary intervention. Never claim unexecuted work or unsupported PASS results.
- Record material changes, evidence, remaining blockers and next steps in the repository/PR. Stop verification cycles once agreed acceptance criteria are satisfied; reopen only for concrete new defects or material changes.

## Non-negotiable safety boundaries

- Preserve the original production workbook, Calendar, scripts and triggers. Work on the separate CRM v2 TEST environment and explicitly approved reused TEST calendar. No production activation, merge or destructive operation outside the authorized scope.
- Never run competing booking writers. Preserve stable Calendar IDs, prevent duplicate bookings and payments, and retain backup/audit evidence. Do not infer missing payment, price, direction or format from unsupported data.
- Keep Telegram disconnected from CRM v2 until its separately authorized integration step. Never expose tokens, personal contacts, private target IDs or customer records in public repository documentation.
- Report live test results separately from unit/CI results. A successful mocked test does not establish a successful live deployment.

These rules govern subsequent project work and agent handoffs unless the owner explicitly changes them.
