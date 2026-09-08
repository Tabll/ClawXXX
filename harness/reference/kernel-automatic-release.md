# Automatic kernel production publication

Status: code implementation and local verification completed on 2026-09-08.
On 2026-09-09 the user authorized commit, push and the first protected production
publication. This operation is in progress; completion requires actual live
catalog/mirror evidence, not just a successful source commit.

## Scope and invariants

The approved workflow automatically joins a complete trusted runtime build and
the same source commit's three-platform Electron E2E. It then queues the
existing `kernel-production` environment. Required reviewer rules are preserved;
automatic triggering is not automatic approval. Manual dispatch remains an
escape hatch for initial bootstrap and reconciliation, not for skipping gates.

Publisher code is checked out at the reviewed workflow commit. The artifact
source SHA is independent, checked against GitHub's exact successful run and
the frozen source manifests. This permits promotion of already verified build
#21 without rebuilding or changing its signed kernel bytes.

## Transaction

1. Read-only selection checks trusted repository/workflow/main/source ancestry,
   current frozen source hashes, complete required jobs, same-source E2E and
   non-expired immutable Actions artifacts. Either completion event may trigger
   the join; neither event alone is acceptance.
2. Under one production concurrency group, revalidate the candidate and local
   complete signed descriptor/archive set with protected public trust roots.
3. Determine the next exact monotonic catalog and latest-per-target set. Refuse
   an older candidate, reused identity with different bytes, unknown kernels,
   missing targets, invalid validity windows and concurrent mirror forks.
4. Persist an immutable signed release record containing the exact catalog,
   source/run evidence, the complete release-matrix snapshot, maximum historical
   catalog expiry per active artifact and explicit pending retirement descriptors. Upload all
   immutable runtime assets and record to both configured mirrors; repeat only
   idempotently. Existing conflicting bytes are never overwritten.
5. Verify every target's online ranges and validators, then replace only the
   two signed catalog pointers. Read back identical catalogs and repeat all
   target checks before recording release success or permitting any deletion.
6. Clean up only explicit retired objects from verified signed records. Retired
   means no longer offered, not security-revoked. Never delete a current catalog
   reference, installed runtime, host installer or arbitrary untracked COS key.

## Retention and maintenance

Catalogs normally last seven days, capped by artifact and signing-key expiry.
Renewal starts with less than two days remaining and reuses the same approved
runtime bytes. A descriptor cannot be silently renewed past its own expiry;
that needs a newly reviewed immutable runtime revision.

Old packages remain until every signed catalog that referenced them expires,
plus a 24-hour download grace. Thus steady state offers one package for each
enabled kernel/platform/architecture (ten today), while transitions temporarily
retain old bytes for cached catalogs and in-progress downloads. Cloud rollback
or reinstall of retired versions is unavailable after cleanup; verified local
last-known-good runtimes and local archive repair are unaffected.

Daily maintenance or manual maintenance dispatch checks for due retirement or
catalog renewal and uses the same protected environment. Approval delays may
delay maintenance and catalog renewal; no bot bypasses reviewer rules. Signed
records/receipts are small and retained for audit even after archive deletion.
Partially completed cleanup resumes exact missing-object operations and never
re-publishes retired bytes. The bucket's versioning policy is checked, so an
apparent delete does not silently leave historical object versions consuming
storage.

Policy expansion does not invalidate historical journals: each record carries
its own complete signed matrix. A new release must satisfy the current expanded
policy; removal of a published kernel/target requires explicit EOL reconciliation.
Shortening a later catalog lifetime cannot shorten older clients' retention:
the signed `activeCatalogExpiry` ledger accumulates the maximum reference expiry.

## Entry points and recovery

- `kernels/release-policy.json`: enabled kernels, reviewed publication target,
  catalog lifetime, renewal threshold and download grace; required targets are
  read from `kernels/platform-matrix.json`.
- `lib/release-gate.mjs`: read-only candidate join and bounded GitHub REST checks.
  Its candidate digest and exact artifact IDs cross the approval boundary; the
  protected publisher rechecks them against live GitHub before writing.
- `publish-runtimes.mjs`: protected CI entry, public-root/private-signer check,
  archive streaming hashes and scoped COS/GitHub backend. It never rebuilds or
  resigns the accepted kernel descriptors/archives.
- `lib/release-record.mjs` / `release-publication.mjs`: signed journal/receipt
  schema and failure-injectable publication/renewal/cleanup state machine.
- `lib/release-maintenance.mjs`: unprivileged hints only, to avoid requesting
  production review when neither renewal nor retirement is due.

Manual `mode=publish` requires an exact successful runtime run ID. Only the first
publication uses explicit `bootstrap=true`; normal events cannot initialize
missing catalogs. Manual `mode=maintain` requires no Actions artifacts. Existing
reviewer/branch rules are unchanged, and waiting for approval counts toward the
shared production serialization. GitHub may delay a scheduled run or replace a
pending run in a concurrency group, so manual dispatch remains the recovery path.

COS catalog replacement is a mutable PUT; GitHub requires delete/re-upload of
only `kernel-catalog.production.json`. N/N-1 and N/404 recover from the exact
reserved signed N record; N/404 after bootstrap additionally verifies its signed
N-1 predecessor. No new issue time, sequence or candidate is invented on retry.
An expired pending record, changed main frozen inputs, revoked signing root,
conflicting immutable object or missing legacy journal stops normal automation
for explicit reconciliation. Untracked legacy objects are never guessed/deleted.

The kernel GitHub release must allow catalog asset replacement; GitHub immutable
release mode is rejected. It is created with `make_latest=false` so it cannot
replace the host app's latest-release pointer. Only a documented empty `starter`
asset left by a failed GitHub upload may be removed for upload retry; nonempty or
digest-conflicting assets are never clobbered. Both mirrors and all required
targets must expose HTTPS, exact signed size, 206 ranges and stable strong ETags.

Private keys, CAM credentials and signed request headers are excluded from logs
and evidence. Public candidate, catalog/journal/receipt, bucket preflight and
online reports are retained as CI evidence for 90 days; small signed remote
journals/receipts remain even after their runtime bytes are retired. This does
not assert verification of the outer Actions ZIP from its metadata digest alone:
the action downloads by the bound immutable ID, then all inner archive,
descriptor and checksum bytes are verified against protected signed metadata.

## Validation

On 2026-09-08 the actual new read-only gate accepted staging
[build #21](https://github.com/Tabll/ClawXXX/actions/runs/34205494108), bound to
source `45bb92609a2349ed89e50c45c64cac53f1aa2620`, same-source
[E2E #35](https://github.com/Tabll/ClawXXX/actions/runs/34195995688), all 25 runtime
jobs, three E2E jobs and 10 non-expired immutable artifact IDs/digests. Accepted
candidate digest: `7d731c6d84707f50ba9bdd1edc3f5b03b69027f8d7bec7d0960c93eac10e5b8f`.
Live API checks exposed and fixed the three-dot compare route and Ubuntu runner
name parsing; both have regression tests, not just mocked happy-path evidence.

Local verification completed on 2026-09-08:

- 119 focused release/distribution/trust/source tests passed, including signed
  bootstrap, partial N/N-1 and N/404, immutable-intent retry, unsafe/stale/forked
  inputs, future third-kernel matrix expansion, shorter-TTL maximum retention,
  failed upload stream closure, receipt mirror repair and interrupted cleanup.
- Full suite: **2437 passed, 6 existing artifact-conditional skips**, 266 passing
  test files and two existing skipped files. No new conditional acceptance skips.
- Typecheck passed; lint has zero errors and seven pre-existing Fast Refresh
  warnings. Frozen source verification, comms replay/compare and Harness CI
  (19 tests) passed. Task diff-aware validate/dry-run, workflow YAML parsing and
  `git diff --check` passed.
- Four README locales, runtime security/support, architecture, design, release
  runbook and Harness rules/scenario/task are synchronized. No visible UI or
  Renderer/Main communication behavior changed in this release-tooling task.

Production bootstrap/online cleanup was **unperformed at implementation handoff**,
not a passing local simulation. Implementation did not use production private
keys or write/delete remote objects. The first protected publication authorized
on 2026-09-09 is tracked separately in MK-2007. The genuine same-source staging/E2E
acceptance above is read-only evidence, not proof of a published catalog. This design does not claim that a
successful CI build alone proves production publication, a real Provider or
Channel account test, or host App/DMG Gatekeeper acceptance.

## API references

- [GitHub workflow_run events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run): completion is not an AND gate or implicit acceptance.
- [GitHub release API](https://docs.github.com/en/rest/releases/releases): release identity and `make_latest`.
- [GitHub release asset API](https://docs.github.com/en/rest/releases/assets): uploaded digest/state, exact asset deletion and empty starter recovery.
- [Tencent COS versioning/deletion](https://cloud.tencent.com/document/product/436/14119): ordinary deletion must not be confused with purging historical versions.
