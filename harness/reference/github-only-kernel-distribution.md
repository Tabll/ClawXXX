# GitHub-only optional kernel distribution

## Scope and authority (2026-09-19)

This supersedes the COS/dual-mirror parts of `kernel-automatic-release.md`.
Only optional kernel distribution changes. Host installer publication in
`.github/workflows/release.yml`, signing environments, local installations,
canonical SQLite, UI, Channels, Cron, Agents and Skills remain unchanged.

The only active backend is `github-release`, bound by release-policy schema 2
to `Tabll/ClawXXX` and the `kernel-runtimes` tag. The container stays public,
non-draft, mutable and `prerelease=true`, so it never becomes the host updater's
latest release. GitHub immutable-release mode is incompatible with this fixed
container's mutable catalog and exact old-package retirement.

The client configuration contains one catalog URL and one artifact base URL.
Configured artifact bases are exhaustive, not fallbacks appended to a signed
URL. A legacy descriptor's COS URL is authenticated identity, not an instruction
to contact COS. Omitted source options allow internal explicit direct-artifact
callers; an explicitly empty source list fails closed. Decode and validate a
single basename before URL encoding to avoid double-encoding `+`.

CI emits GitHub-canonical descriptors with new immutable revisions:

- OpenClaw `2026.9.4+clawx.15`.
- DeepSeek Harness `0.1.5-rc.2+clawx.15`.

Upstream commits, dependencies and Node 24.20.0 are unchanged. Runtime config,
OpenClaw bridge version and frozen hashes advance together. Promotion never
rewrites/resigns accepted artifacts. The kernel publisher neither initializes
COS nor reads COS credentials, catalogs or objects.

## Publication and recovery

1. Join complete build/single/dual acceptance and same-source three-OS E2E.
2. Require production environment approval and revalidate candidate, signatures,
   hashes, the complete matrix and exact GitHub destination.
3. Authenticate the existing catalog and immutable signed journal chain.
4. Reserve the next signed journal, upload immutable versioned assets, and verify
   Range/If-Range, strong stable ETag and signed size for all ten targets.
5. Replace only `kernel-catalog.production.json`. GitHub uses delete + upload,
   not atomic overwrite. Verify the exact new signed pointer before cleanup.
6. Retire exact inactive GitHub archives/descriptors/checksums after the maximum
   expiry of all signed references plus 24 hours; preserve journals and receipts.

One source and ten targets require twenty Range requests, not forty. Removing
the fixed two-host count does not permit partial success: every configured
source must pass. Ed25519, SHA-256, HTTPS, rollback protection, notarization and
complete CI acceptance remain mandatory.

A missing pointer is not bootstrap. The backend reads the bounded GitHub asset
inventory without creating a release, then authenticates journals. Sequences
must be contiguous and unique; signed sequence must match filename and loaded
predecessor digests must match. With no pointer the complete chain is verified.
A current pointer must match its immutable journal. Recovery uses the exact
reserved candidate and bytes, not a new signature/sequence. Metadata renewal
can recover without runtime uploads only if its predecessor offers the same
artifact fingerprint. HTTP errors other than absence are fatal.

The client retries catalog HTTP 404/429/502/503/504 at most twice after the first
attempt, then uses its verified cache. Expired caches cannot authorize new
installs. Signature and rollback failures are not retried. A crashed publisher
may leave fresh clients temporarily unable to install until protected recovery;
GitHub-only is not an atomic pointer service.

## Explicit pending-intent supersession

Automatic publication still rejects changed reserved intent. An expired or
legacy COS reservation may be superseded only by a manual publish with
`supersede-pending-sha256`, under the same production approval. Its value is
`digestJson(record)` (SHA-256 of canonical JSON, not the downloaded file hash).
The CLI enforces workflow_dispatch + publish + exact digest.

The publisher verifies the pending head and writes its successor, never edits
or deletes the old record. The successor links to the pending catalog and
inherits its retention ledger, including never-activated but publicly signed
references. New identities are checked against that pending head, so changing
same-revision URLs/bytes remains forbidden. Retries bind the same predecessor
digest and successor candidate, including after record upload or catalog switch.
A changed head fails. Active packages and host installers cannot be deleted.

Historical URL roots in policy are validation-only for signed old active and
retired descriptors. They are not new artifact roots, download sources, metadata
sources or deletion destinations. Removing them before reconciling history is
unsafe. Old COS objects and host-installer secrets are not deleted by this change.

## First deployment checklist (not executed by local implementation)

- Do not approve old queued dual-source workflows. Explicitly cancel/supersede
  them before cutover, avoiding an old publisher executing after migration.
- Commit/push, run the complete `.15` build with the GitHub base URL, and require
  same-source Electron E2E and all signing/clean-machine gates.
- Reinspect the live signed catalog and journal. At assessment time sequence 1
  (`.13`) had expired on September 16; sequence 2 reserved `.14` but never became
  active. Do not assume that snapshot still holds at deployment.
- If sequence 2 is still pending, verify its signatures and compute its canonical
  digest. Manually publish the accepted `.15` build with that supersession input
  and normal approval. The expected successor is 3, not a reset to 1.
- Verify live signature/sequence, all ten GitHub downloads and Range checks,
  fresh-host installation and signed cleanup evidence. No COS writes.
- Update the host application/configuration too: existing old binaries retain
  COS-first settings until updated; changing the server alone cannot prevent
  old clients trying COS.
- Scheduled GitHub Actions were disabled at the user's request on 2026-10-15.
  Request protected maintenance manually when due. Missing maintenance or delayed
  approval can still expire the seven-day catalog.

## Verification boundaries

Offline failure injection covers bootstrap, missing pointer, renewal, expired
reservations, exact-digest migration, changed intent, journal gaps/forks, upload
failure, deferred retirement and no-COS routing. New real GitHub publication and
`.15` platform artifacts still require the protected CI checklist; local tests
do not prove that production has switched.

Read-only verification on 2026-09-19 fetched records 1 and 2 solely from GitHub
and successfully validated their real production signatures and predecessor link
under the new policy. Record 2 canonical digest was
`aa89d74007d8a032add04fdd0b42d4ea149eaeda663e4ff7826792ed6bda2a18`.
This is historical-chain compatibility evidence, not approval of the expired
sequence-1 catalog and not authorization to reuse this digest without a fresh
deployment-time check.

Local validation on 2026-09-19:

- Node 24.20.0: full Vitest run, 2,580 passed, 6 skipped, 0 failures;
  16 dedicated GitHub-only migration/transport cases included.
- Real Electron Main integration: both kernel downloads interrupted and resumed
  using only configured GitHub URLs, with complete byte/hash equality. HTTP
  responses are controlled fixtures; this is not a live new-artifact CI test.
  The macOS sandbox initially blocked app launch; the same isolated test passed
  outside the sandbox without using real application data.
- Typecheck, frozen source/hash verification, comms replay/compare, Harness CI,
  task-spec validation/dry-run and `git diff --check` passed.
- Lint: 0 errors, 7 existing React refresh warnings in unchanged UI files.

No commit, push, approval, remote package mutation or COS cleanup was performed.
