# Windows runtime CI repair — OpenClaw +clawx.8

## Failure and root cause

[Build 34040448610](https://github.com/Tabll/ClawXXX/actions/runs/34040448610)
at `84ae366c` completed with eight successful non-Windows builds and two failed
Windows builds. Single/dual clean-machine matrices were skipped; the same
commit's three-platform Electron E2E passed. This is not production publication.

OpenClaw failed startup's `persisted-registry-stale-source` check. An isolated
Windows 11 / Node 24.15.0 reproduction established this sequence:

1. Configured plugin paths use Windows 8.3 aliases, while async `realpath`
   install records use long paths. Discovery reports duplicate plugin IDs.
2. `prepareInstalledPluginPaths` previously scanned object insertion order.
   SQLite serializes the install-record map in owner order.
3. After a fresh cache and SQLite reread, diagnostic **order**, not diagnostic
   content or the selected plugin records, changes. The whole registry comparison
   fails, while per-plugin `differences` is empty.

The patch sorts install-record entries by owner **before scanning**. Explicit
configured load-path priority, package selection, physical boundary checks,
hashes, strict comparisons, migration leases and checkpoint guards are unchanged.
No diagnostics are ignored or sorted away at the comparison layer. The same
real Windows short-path fixture becomes `persisted` with no differing keys.

`probe-openclaw-plugin-registry.mjs` reproduces the duplicate-discovery condition
on every OS with two separate, never-executed plugin copies and reverse install
order. It uses the exact pinned compiled registry and a private SQLite database,
requires three fresh-cache write/read cycles, and rejects real manifest,
entrypoint, policy and diagnostic-content changes. The old +clawx.7 payload fails
this regression on macOS as well. CI runs it on each OpenClaw payload before the
existing real Gateway/ACP/seven-Channel probe and before signing.

## Other Windows fixes

- Artifact fsync opens `r+`, not `r`: Windows requires write access for flushing.
  The archive is neither recreated nor truncated; flush failures are fatal and
  descriptors close in `finally`. Isolated Node regression covers writable-handle
  enforcement, injected EIO, unchanged bytes and missing-file rejection.
- Strict patch fixtures set local `core.autocrlf=false` and `core.eol=lf`.
  Regression supplies private global configs with both autocrlf values and CRLF
  preference; it does not modify the developer's Git settings. Exact LF and
  offset rejection remain mandatory.
- DeepSeek driver assertions construct native absolute paths with `resolve/join`,
  including spaces, and retain exact install identity and traversal rejection.
  Production path resolution is unchanged.

## Frozen identity and verification boundary

OpenClaw is `2026.9.2+clawx.8` / patch revision 8. The upstream npm version,
commit and archive integrity are unchanged. The patch adds one reviewed compiled
discovery target (23 targets total). Root pnpm lock changes only its 24 affected
patch-hash references; no dependency versions change. Runtime, control overlay,
overlay manifest and source/lock hashes are synchronized. DeepSeek remains
`0.1.3-alpha.1+clawx.11` with its own frozen upstream lock unchanged.

Local verification (2026-09-06–07): 2184 host tests passed, zero failed, six
existing conditional tests pending; focused repair suites passed 20 tests.
Frozen install/preparation, source hashes, typecheck, lint (seven pre-existing
warnings), comms and Harness checks passed. The real Windows registry probe also
passed all three round trips and four negative cases. The rebuilt macOS arm64
payload passed the existing full Gateway/ACP/seven-Channel/storage probe.
Local validation and staging execution are tracked separately in TODO M19 CI.
The Windows VM reproduction is a metadata/SQLite test using a copied payload,
not a substitute for a native Windows CI build, signing, full Gateway/Channels
or clean-machine installation. The new full workflow must use the repaired SHA,
both kernels and all five targets, with explicitly deferred Windows Authenticode.
No COS upload, catalog promotion, installed-kernel replacement or production
release is authorized by this task.
