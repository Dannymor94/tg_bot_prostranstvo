# CRM v2 — managed title editing and diagnostic checkpoint (2026-11-25)

- Managed Calendar title changes now accept the explicit grammar "Tenant — Direction" when the tenant resolves uniquely. The title supplies tenant and direction; format/status remain from structured metadata. No fuzzy matching or new tenant creation. The same booking/event ID is preserved.
- Runtime reconciles the effective booking with Sheet and accepted state, then conditionally normalizes Calendar metadata using ETag. Unknown/ambiguous titles remain review-only. Normalization preserves payment status; an active payment instruction blocks normalization and must be resolved explicitly. A later pass can retry a failed normalization. Existing tenant rename propagation and arbitrary edits of technical description are not supported.
- Date, start and end are treated as one logical interval in the merge planner. Different simultaneous interval edits conflict, even if a field-wise combination would be valid. Independent interval and direction changes still merge. No implicit cancellation reversal.
- Owner-only status now includes bounded diagnostic booking IDs and reasons, finance review count and scan-limit notice. This is the last reconciliation report, not a service uptime guarantee. No automatic conflict resolution or production protection changes implemented.
- Regressions exercise title resolution, unknown tenant, metadata normalization, active payment marker, stale ETag, interval conflicts and diagnostics.

Code/test commit 70b291d24913ad3869eefd97a6072bf6ab636770. CI evidence tracked in PR #2.

Remaining release gates: explicit quote review approval (including keep/recalculate decisions), conflict repair and strict protections, backup/restore, migration rehearsal, real isolated GAS/Calendar/Telegram activation and end-to-end acceptance. Calendar/Sheet concurrent UI edits remain non-atomic; conditional writes and checks mitigate rather than eliminate that risk. No deployed services, production data or old-system changes.
