# CRM v2 — tenant preparation and independent workbook restore (2026-11-26)

## Completed directly by ChatGPT

- Read private migration copy, 69-event archive, 56 reconciliation entries (55 source entries plus one calendar-only entry) and old tenant directory. 15 distinct source labels; 12 occur in the Calendar archive and 3 only in the source review. No reliable format/direction for these real bookings was established. Historical examples and duration are not evidence of format.
- Added exactly 15 unclaimed draft rows in TEST Арендаторы, rows 3–17, preserving the existing synthetic fixture. Four owner-confirmed categories (2 regular, 2 internal); 11 ordinary categories are preliminary, explicitly marked as such in notes. Two contacts copied only from unique, exact full-label matches in the private historical directory. Ambiguous or missing contacts remain blank. No customer names, contacts or target IDs published in this report.
- No tenant ID, direction, format or recurrence rule assigned to the drafts. They cannot become managed profiles through incomplete-row intake. No real booking, payment, calendar event, migration approval or accepted record written. All six discrepancy entries remain held.
- Readback: 15 unique draft labels, all 15 without direction/format/ID, 2 contacts, original synthetic fixture retained; category/format validation preserved; effective colors correct for 2 regular, 2 internal and 11 ordinary entries. Notes wrap enabled; native browser rendering not independently inspected.
- 50 exact or corrected interval correspondences cover 5 tenant labels. Obtain owner-confirmed direction and format for these labels first; keep any per-booking exceptions held. Then use reviewed legacy import with original event IDs; never insert replacement bookings through normal Sheet intake. Do not invent historical quotes or receipts.

## Independent workbook restore rehearsal — PASS (copy/structure/content only)

Found the private post-handover native workbook backup dated 2026-11-26 in the owner-only backup folder. Created a separate owner-only native restore copy in that folder, named RESTORE-TEST-2026-11-26 — independent verification (localized title). Source, active CRM and production workbook untouched.

Readback verified matching locale/timezone, nine tab names/order, dimensions and hidden states. Compared FORMULA-rendered cells over the complete allocated grid of each tab in bounded ranges, including all 20,001 journal rows; every range matched exactly. Source backup predates the live E2E and archive creation; empty runtime tables are therefore expected. Restore copy is not bound to any script or calendar by this action. Do not enable writers on it. No calendar or script-property state was restored. Connector exposes only the native workbook in the private backup folder; GAS must verify the manifest/payload and rehearse Calendar/state restore on a separate target. This is not a full disaster-recovery PASS.

## Finance verification and remaining live acceptance

Independent read of CI job 139911336044, run 45820539910 at c8db0c337734284c0f4ca2fa618b80f88e37088f: 242 tests, 242 pass, 0 fail/skipped. Confirmed explicit passing coverage of minute-level tariff bands, weekends, regular discount, internal zero rate, quote snapshot/review, partial receipt and full settlement, refund/excess refund, replay/lost response, cancellation retaining payments, and external booking without inferred quote. No rerun required for unchanged code.

Only live GAS actions remain for finance and full restore. Use a fresh private TEST workbook and a separate TEST CRM v2 calendar for synthetic financial fixtures; no fake payments in the active TEST CRM or production. Keep Telegram and other writers off. Record test scope, exact target identity privately, before/after counts, stable payment/booking IDs, readback and guard outcomes. Exercise these explicit amounts under the approved tariff:
- Weekday ordinary individual, 16:30–17:30: 750 RUB; regular: 675 RUB.
- Weekday ordinary group, 16:30–17:30: 850 RUB; regular: 765 RUB.
- Weekend ordinary group, 09:30–10:30: 900 RUB; regular: 810 RUB.
- Internal booking: zero price and reject receipt. Do not infer settlement as a payment.
- Ordinary 750 RUB fixture: receipt 250, outstanding 500; full settlement 500, outstanding 0; repeat same intent adds no row; refund 250, outstanding 250; excess refund rejected. Cancellation preserves ledger; refund any remaining test receipt only explicitly. Verify both Sheet and Calendar payment markers on synthetic stable bookings, deduplicating same-revision settlement.
- Verify missing quote holds financial projection, and a moved booking requires price review without changing actual receipts.

For full restore, independently verify backup manifest/workbook/Calendar payload/state; use fresh isolated targets only. Preserve active event IDs and semantic fields where provider permits, retain cancelled tombstones and server-generated metadata in archive rather than inventing live events. Verify no operational state leaks or replay against live targets. Report exact limitations if provider cannot recreate some fields. No release approval until live checks pass.

No old production system, Telegram, existing customer calendar events, or actual receipts changed in this checkpoint.
