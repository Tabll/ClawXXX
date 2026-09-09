# Automatic kernel production publication

Status: first protected production publication completed on 2026-09-09.
[Production #4](https://github.com/Tabll/ClawXXX/actions/runs/34296346239)
finished successfully at 00:47:50 UTC. Sequence 1 serves all ten original
revision-13 kernel archives on COS/GitHub, with matching verified signed
catalogs and all-target Range/If-Range evidence. No packages were retired by
this initial publication. Host-app release and real-account acceptance are
separate, uncompleted gates.

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

Post-write verification first allows bounded HTTP propagation (six probes,
five-second intervals, independently bounded requests), including two mirrors
still serving the same old catalog. It requires the exact reserved catalog
before any post-switch archive drill or final strict readback. A signed same-sequence
conflict or newer sequence fails immediately rather than being hidden by retry.
Exhaustion, late divergence and Range failure still prohibit cleanup.

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
release mode is rejected. Its fixed-tag asset container uses `prerelease=true`
and `make_latest=false` to exclude it from host-app latest-release discovery.
The GitHub label is not the signed runtime catalog's production channel. Only a documented empty `starter`
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

## First protected publication — 2026-09-09

- Implementation commit `1dc4ebea233c097e6f3a8ecda853d7572e2d8082` was pushed to
  `main`. [E2E #37](https://github.com/Tabll/ClawXXX/actions/runs/34250881803)
  passed all three platforms on attempt 2; the first Windows attempt had two
  `electronApplication.firstWindow` startup timeouts. Only failed jobs were
  rerun; no test was skipped, weakened or assigned a larger deadline.
- [Production #2](https://github.com/Tabll/ClawXXX/actions/runs/34294723902)
  started at 00:22:21 UTC with `publish`, build `34205494108`, exact source
  `45bb92609a2349ed89e50c45c64cac53f1aa2620` and explicit `bootstrap=true`.
  Read-only acceptance passed and normal `kernel-production` review was
  approved at 00:24 UTC, without changing environment protection.
- All ten original archives plus their descriptors/checksums reached both
  mirrors. The archived pre-switch drill passed all 40 Range/If-Range requests.
  COS preflight reported `ap-shanghai`, versioning `Disabled`. No kernel bytes,
  notarizations, artifact signatures or revision-13 source pins were changed.
- The attempt stopped at 00:30:54 UTC on immediate post-write catalog readback,
  before the existing bounded visibility retry could execute. No deletion was
  performed. The immutable sequence-1 journal and both uploaded catalog assets
  were preserved. This failed attempt alone is not a successful protected
  workflow result; subsequent recovery is recorded below.
- Independent live verification using the protected CI public roots subsequently
  passed: both exact signed catalogs returned 200/conditional 304, and all ten
  targets on both hosts returned 206 for Range and If-Range with stable strong
  ETags and exact signed sizes. The observed convergence supports a transient
  post-upload visibility failure; the first failing read did not archive raw
  per-mirror responses, so its precise stale response is not asserted.
- Sequence 1 issued at `2026-09-09T00:25:09.207Z`, expires at
  `2026-09-16T00:25:09.207Z`. Catalog file SHA-256 (including final newline):
  `11ef22322d85a1d05e8b9b452105cf8c2329ed4b7174ca480b0876d882033ccd`;
  canonical JSON digest: `3e4fc5dfac49b64fa5e7cea58b3aeb310df4a590ef4c6c842a7eee5826acda14`.
  Journal file SHA-256:
  `132b184e4a1dd5f2bd56d12e89aa2cd544dd9556e65b702bf229b057034e2523`.
  The signed retirement list is empty: first bootstrap cannot prove a real
  historical-package deletion.
- Evidence artifact `10082893235` (`kernel-production-evidence-34294723902-1`)
  SHA-256: `566f108662c96123fa3aff6e0c4eac1a709a8390f1e1073740ee20a9d962537a`.
  Downloaded ZIP identity and signed release record were independently checked.
- The visibility-order repair adds eight regressions (temporary missing/old
  mirrors, exact-release retry exhaustion, immediate signed conflict/newer
  rejection, post-write ordering and late-divergence cleanup protection).
  All **2445 unit tests passed**, with the same six pre-existing conditional
  skips; typecheck, lint (zero errors/seven existing warnings), frozen sources,
  comms replay/compare, Harness CI (19 tests), task validate/dry-run and diff
  checks passed. The repair changes no frozen runtime input or signed package.

### Successful protected recovery

[Production #4](https://github.com/Tabll/ClawXXX/actions/runs/34296346239)
ran from repair commit `5574a907b56ae7a7a139d5f53b890eeec3dfc1c4`, starting
at `2026-09-09T00:45:20Z` and finishing at `2026-09-09T00:47:50Z` with both
jobs successful. It used `bootstrap=false`, because both sequence-1 catalogs
already existed and matched; the original build ID/source SHA were unchanged.
The read-only gate and normal production reviewer approval both ran again.

The protected result was `ok=true`, `mode=already-published`, `sequence=1`;
`deleted`, `deferred` and `alreadyCompleted` were all empty. Both catalog URLs
returned 200 and conditional 304. All ten kernel/target entries passed both
hosts' Range and If-Range probes (40 responses, all 206, strong stable ETag,
exact signed size). The successful public roots and signed journal bytes were
compared with the first attempt and are identical; no issue time, expiration,
sequence, runtime revision or original signature changed. GitHub has 32 release
assets: 10 archives, 10 descriptors, 10 checksums, one catalog and one journal.

Successful evidence artifact `10083318832`
(`kernel-production-evidence-34296346239-1`) has ZIP SHA-256
`7258a3329505d2bae2efef358b5ba95d47c184c83349c0967f52fa08cffd328c`.
Its ZIP identity, signed journal, unchanged public roots and all 40 online
responses were independently inspected. This genuinely exercises idempotent
acceptance of the already uploaded release; the repaired fresh-pointer
propagation path is covered by regression tests, not a newly minted sequence.

Available versions are OpenClaw `2026.9.2+clawx.13` and DeepSeek Harness
`0.1.3-alpha.1+clawx.13`, each for macOS arm64/x64, Linux arm64/x64 and Windows
x64, with Node 24.20.0. Existing installed runtimes/SQLite were not mutated.
No historical-package deletion can be claimed from an empty retirement list.
Future protected maintenance must renew the seven-day catalog before its
expiry; ordinary environment approval remains required.

### Host-app latest-discovery isolation

Final live inspection found the repository had no host releases, so GitHub's
`/releases/latest` selected the sole full `kernel-runtimes` release despite
the original `make_latest=false`. The GitHub resource page was changed at
`2026-09-09T00:57:19Z` to `prerelease=true`, preserving its tag, all 32 assets
and public fixed download URLs. `/releases/latest` then returned 404, correctly
reflecting that no host-app release exists. Release notes explain that this
classification is only to exclude the asset container from App discovery;
the independently signed catalog remains `channel=production`.

The publisher now creates only this excluded classification and rejects an
existing kernel container whose prerelease flag is false/missing. This requires
explicit metadata reconciliation instead of silently publishing into the host
latest pool. Two rejection regressions and the creation-payload assertion cover
the behavior. Neither `electron-builder.yml` nor the App updater's legacy feed
configuration was changed; host-app packaging/distribution is a separate task.

After reclassification, an independent check matched all 32 GitHub assets'
names, sizes, uploaded states and SHA-256 values to the original signed journal
and catalog. Both signed catalogs again returned 200/304 and all 40 Range/
If-Range responses were 206. Local validation reached **2447 passed / six
existing conditional skips**, with typecheck, lint (zero errors/seven existing
warnings), frozen-source verification and task validate/dry-run passing.
[Repair E2E #38](https://github.com/Tabll/ClawXXX/actions/runs/34296175354)
for commit `5574a907` completed successfully on all three platforms.

## API references

- [GitHub workflow_run events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run): completion is not an AND gate or implicit acceptance.
- [GitHub release API](https://docs.github.com/en/rest/releases/releases): release identity and `make_latest`.
- [GitHub release asset API](https://docs.github.com/en/rest/releases/assets): uploaded digest/state, exact asset deletion and empty starter recovery.
- [Tencent COS versioning/deletion](https://cloud.tencent.com/document/product/436/14119): ordinary deletion must not be confused with purging historical versions.
