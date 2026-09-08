---
id: multi-kernel-runtime
title: Multi-Kernel Runtime
type: runtime-bridge
ownedPaths:
  - kernels/**
  - patches/openclaw@*.patch
  - patches/deepseek-harness@*.patch
  - scripts/kernel-runtime/**
  - electron/kernels/**
  - electron/data/**
  - electron/services/conversation-*.ts
  - electron/services/kernel-*.ts
  - electron/services/acp-*.ts
  - electron/main/ipc/**
  - shared/kernels/**
  - shared/conversations/**
  - shared/host-api/**
  - src/lib/host-api.ts
  - src/lib/api-client.ts
  - src/stores/**
  - src/pages/**
  - tests/contract/kernels/**
  - tests/e2e/kernel-*.spec.ts
  - electron-builder.yml
  - package.json
  - pnpm-lock.yaml
requiredProfiles:
  - fast
  - comms
conditionalProfiles:
  e2e:
    when:
      - optional kernel install, update, rollback, or uninstall behavior changes
      - visible kernel selection, status, capability, or error behavior changes
      - dual-runtime lifecycle, routing, channels, cron, agents, or skills behavior changes
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - host-events-fallback-policy
  - comms-regression
  - kernel-runtime-distribution
  - multi-kernel-isolation-and-routing
  - kernel-capability-isomorphism
  - unified-conversation-storage
  - ui-i18n-design-tokens
  - e2e-parallel-isolation
  - docs-sync
forbiddenPatterns:
  - window.electron.ipcRenderer.invoke in src/pages/**
  - window.electron.ipcRenderer.invoke in src/components/**
  - npm install in electron/kernels/**
  - pnpm install in electron/kernels/**
  - deepseek-harness-web in src/**
  - node:sqlite in electron/kernels/**
  - new DatabaseSync in electron/kernels/**
---

This scenario governs optional OpenClaw and DeepSeek Harness runtime packages, the Main-owned multi-kernel abstraction, kernel-scoped execution routing, a kernel-independent Conversation identity, the single SQLite Conversation Store, concurrent process lifecycle, canonical capability projections, and host-owned Channels/Cron orchestration.

The durable architecture and release gates are defined in `harness/reference/multi-kernel-runtime.md`. Work in this scenario must also use `gateway-backend-communication` when it changes Renderer/Main, Host API, ACP, Gateway, bridge, or runtime message paths.

Both runtimes must satisfy one canonical ClawX UI and storage contract. Upstream-specific models stay inside drivers and bridges. Runtime packages are immutable CI products downloaded on demand, not dependencies installed or patched on the end-user machine. Managed runtimes do not retain a second durable conversation, cron, channel-message, or usage history.

Builder portability includes checkout/system-temp volume separation, verified
same-volume staging and failure cleanup for both source and Node downloads.
Complete native Channel entrypoint imports use bounded isolated processes,
without weakening syntax/export assertions or the real packaged-runtime
probes. The CI checks and remaining release gates are documented under
`harness/reference/multi-kernel-runtime.md`.

Windows portability also covers deterministic plugin-registry diagnostics across
SQLite round trips, writable archive flush handles, LF-exact Git fixtures and
native driver path assertions. Keep actual metadata/policy changes fail-closed;
see `harness/reference/windows-runtime-ci-repair.md` for reproduction and gates.
ACP fixtures must round-trip native absolute workspace paths through encoded
file URLs and verify the exact cwd passed to the unchanged adapter. Include
spaces, Unicode, `#` and `%`, malformed-URL rejection and execution-slot release,
all three native executable layouts and owned temporary-root cleanup. Run the
same driver/ACP suites before builds and after real-artifact installation.
Case/8.3/junction aliases must retain the same verified physical install owner,
without trusting a different package by ID. Full real-process startup probes
must retain bounded platform-specific readiness, failure traces, signal/exit
checks and exact-command approval plus execution evidence on Windows as well.
Manifest cache identity must also remain physical across alias-to-canonical
reads, with real hashes and unchanged path-boundary checks. macOS notarization
must persist archive-bound submission identity and recover transient status
queries without repeated uploads or weakening the Accepted gate. Offline
failure-injection tests and real platform execution remain separate evidence.

Platform-specific native package layouts must be verified against frozen inputs.
Use exact esbuild executable paths, with all-target native-header and negative
path fixtures before builds, plus Windows-target artifact assembly regression.
The complete real payload audit and clean-machine gates remain mandatory.

Portable PAX archives must retain complete long/Unicode paths, with a decoded
file-manifest check before descriptor signing. Production extraction validates
effective PAX paths and signed budgets without weakening traversal, collision
or link rejection. Shared UI compilation generates both extension bridges in
its own build entrypoint; a clean checkout must not depend on prior dev outputs.
Both kernels receive new immutable identities when shared archive encoding changes.

Archive-budget regression fixtures must cover the exact signed boundary and
post-EOF overflow while keeping parser buffer-copy work bounded. Prefer valid
bounded PAX records over a huge EOF trailer; preserve real decompression and
production limits, and enforce fixture cost with operation counts rather than
runner-dependent timing assertions. Test-only repairs do not change kernel pins.

Storage contracts must observe completed admission and durable SQLite terminal
writes with explicit bounded event barriers, not timer polling or early fake
request counts. Preserve per-thread serialization, dual-kernel concurrency,
Cron skip/replace/restart deduplication and real FULL-sync on-disk readback.
Pure Git contracts use Node, bounded real repository setup, both autocrlf
policies and independent exact/offset cases. Only Windows storage-suite file
workers are serialized; internal concurrency, deadlines and release gates stay.
Release owned execution gates and drain operations on failure before teardown.
Workflow-policy assertions also exercise LF and CRLF text on every host;
semantic EOL normalization must never alter frozen-source or patch-byte checks.
The loopback model exercises background exec and native process polling,
including adapter-normalized call IDs, exact command/session binding, bounded
continuations, terminal output and complete provider-usage accounting.

Sealed probe reports and Channel CLI replies are read after stdio close, with
bounded output, explicit exit/signal/spawn status and unchanged acceptance
deadlines. Persist incremental closed phase labels and nested process evidence
for failed clean-machine jobs; diagnostic writes must not prevent cleanup.
Timeout or overflow cannot become success during bounded post-kill drain.
Run deterministic close/late-output/failure contracts before expensive builds;
do not infer a native termination's cause from an isolated module warning.

Large runtime file verification uses bounded concurrency without dropping any
signed check. Drain in-flight work before failure cleanup and reject readonly
sealing failures. Real-artifact fault injection operates only on owned temporary
regular files with finally-restored permissions. Production/CI extraction uses
independent 256-entry positive directory caches to bound tar's pruning work;
evicted hints trigger filesystem rechecks, without changing Windows path
reservations or archive safety. Test real trees beyond capacity and concurrent
cache isolation. Single/dual clean-machine
tests retain finite deadlines and incremental phase/timeout evidence; concurrent
operations settle before removing the shared temporary installation authority.
The hash-pinned host tar patch uses ordinary Windows file writes with unchanged
path reservations, modes and verification. Exercise the actual installed
selector for each platform in an isolated test VM and pin raw patch bytes;
normalize only semantic lockfile line endings. Separate native VM throughput
samples from complete GitHub runner acceptance. Optional per-kernel extraction
and rescan stages contain no paths or content, tolerate a broken diagnostic
sink without changing acceptance, and report verified only after readonly
sealing. Keep single/dual 10/15-minute deadlines and corruption rejection.
Windows executable-directory lock recovery remains a finite atomic rename
policy (EPERM/EBUSY only, six attempts, 1500 ms total delays), not an install/test
retry, a permission relaxation, a copy fallback or an active-runtime bypass.

Skills are canonical immutable packages with per-kernel desired and projection state. OpenClaw and DeepSeek Harness roots must be physically independent: no shared root, nesting, root/package symlink, or cross-root resource reference is allowed. Both-target mutations report each result and retain partial state. DeepSeek Harness registers converted instructions through its process-local `ctx.skills` adapter while SQLite remains the sole metadata authority.
