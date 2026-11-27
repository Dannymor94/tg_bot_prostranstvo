# CRM v2 — controlled GitHub Actions source updates (TEST only)

Status: implementation prepared; live authorization, target readback and deploy still required. No credentials in the repository. This is a source-update mechanism, not runtime activation or a production release.

## Why direct Apps Script API rather than clasp push
The existing standalone TEST project contains private helper files and an acceptance script in addition to CrmV2 and appsscript. The API replaces the whole source inventory; a blind push of the public bundle would delete those additional files. The updater reads the existing inventory, replaces only the exact CrmV2 SERVER_JS file, preserves every other file and the manifest, refuses manifest drift and rechecks the full inventory just before writing. It verifies all files after writing and never automatically repeats an ambiguous PUT. There is no API atomic compare-and-swap; nobody may edit the GAS project while a deployment runs. Script properties and triggers are not edited. Runtime preflight still requires a separate authorized invocation; do not claim that a source readback proves runtime acceptance.

## One-time owner authorization (private, do not paste credentials into chat)
1. Identify the existing standalone CRM v2 TEST project in Apps Script. Run read-only crmV2Preflight and verify exact TEST spreadsheet/calendar bindings, no pending/conflicts, all mutation flags off, no v2 triggers. Confirm its title starts with TEST or ТЕСТ followed by space, dash or em dash. If necessary rename only the verified TEST script. Record exact script ID and title privately.
2. Prefer a separate Google deployment identity with editor access to ONLY this TEST script, not to production scripts. The Apps Script API scope script.projects grants access to projects accessible by that identity; it is not restricted to a single script ID by Google. Enable the Apps Script API in the OAuth client's Google Cloud project and enable API access for that Google identity in Apps Script user settings. Create an OAuth client suitable for interactive desktop authorization; obtain an offline refresh token with scope https://www.googleapis.com/auth/script.projects only. A testing-mode OAuth consent configuration may expire its refresh token; check the OAuth app's publication/consent policy. No runtime execution or Drive/Calendar scope is requested by this updater.
3. In repository Settings > Environments create crm-gas-test; allow deployment ONLY from branch feature/studio-crm-v2 (selected branches, not tags); restrict write access to this branch/repository and configure reviewer protection for initial activation. Public forks/PRs must never receive these credentials. Do not configure repository-wide secrets. Owner should consider a separate private deployment repository if unable to ensure trusted branch writers. After initial successful probe/acceptance the owner may remove required human review if they want unattended deployment, keeping branch restrictions and dedicated identity.
4. In that environment only, set two environment secrets directly in GitHub:
   - CRM_GAS_TEST_TARGET: JSON object with scriptId and title (exact verified values).
   - CRM_GAS_TEST_OAUTH: JSON object with client_id, client_secret, refresh_token (Google OAuth values).
   No values in PRs, logs, artifacts or repository files. A separate account and environment restriction are essential; the branch workflow itself is not a security boundary against a malicious authorized workflow editor. Revoke the grant immediately if exposure is suspected.
5. Inform primary developer when authorization is ready; never send secret values.

## Request protocol
A commit to .github/crm-test-deploy-request.json on feature/studio-crm-v2 triggers a fresh test/build job, then the environment-protected source job. No request file is created by the initial setup. No pull_request trigger, no automatic push on ordinary application commits.
- First request: {"mode":"probe"} — no mutation. Compare returned before/after hashes of the application bundle with the known source release and verify the private target. No helper content is published.
- Apply: {"mode":"apply","expectedSourceSha256":"<verified previous source hash>","expectedBundleSha256":"<verified desired bundle hash>"} — only if the probe and TEST runtime preflight match. Desired SHA must be reproduced from the exact source to deploy. A repeat when already current is a no-op. Use a distinct request commit for each run.
- Workflow builds the actual checked-out commit and runs the existing regression suite before Google authorization. Source hashes are printed only on a successful probe/readback. Any failure blocks deployment; inspect privately rather than retrying blindly. No private source artifacts or raw Google responses are uploaded.
- After update, run existing read-only crmV2Preflight in the authorized GAS session; preserve 50 imported rows, 19 REVIEW, no payment or Calendar changes. Runtime acceptance and later activation remain separate.
- Rollback uses an explicitly approved previous Git bundle as the desired source with a fresh current hash; no blind overwrite, no restore of stale Script Properties, no data rollback.
- Do not use this workflow for production.

## Acceptance
Target metadata matches verified standalone TEST project; initial probe matches expected source; CI green; apply/readback verified; all helpers and manifest unchanged; runtime preflight remains safe. Until credentials are configured and the actual live requests complete, DEV-03 is BLOCKED, not PASS.
