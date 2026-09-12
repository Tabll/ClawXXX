# Installed kernel selection and activation

## Selection authority

Both `pnpm dev` and packaged ClawX read the canonical DataService installation
record first. An active installed OpenClaw or DeepSeek Harness uses its immutable
artifact entrypoints and its own Node executable. Development environment paths
and the OpenClaw `node_modules` fallback apply only when no package is installed.
Packaged apps never use those fallbacks. Broken, incomplete or mismatched installed
records fail admission; they must not silently select other bytes against user
state. An installed OpenClaw in development also uses its artifact's Channel
handoff plugin, not the repository overlay.

No user database migration, runtime package rewrite or trust-policy weakening
is part of this fix. An installation's verified state still comes exclusively
from the existing package manager.

## Activation and concurrency

Package mutations are serialized per kernel through the completion of their
host-registration callback, including errors and uninstall. An idle launch
registration takes the same supervisor lock as start/restart/stop. Successful
registration resets stale launch errors and recovery state without incrementing
the process generation; only an actual start allocates the next generation.
Other kernels retain their own process and independent operation queue.

DeepSeek Harness can rebind after install, idle repair or rollback within the
same app session. Its next process captures the selected immutable location;
canonical provider/agent/skill projections still reconcile on readiness.
OpenClaw's ACP and native Channel bindings remain app-scoped: after activation,
the old launch resolver is disabled and Main advertises `restartRequired`.
The app must rebuild those bindings on full restart. This is an explicit safe
deferral, not a claim of OpenClaw hot replacement.

If a start won the lifecycle lock first, registration leaves the live generation
untouched and marks an app restart required. A kernel restart is rejected before
stopping that process. No hot-registration action automatically starts a kernel,
changes auto-start policy or interrupts another kernel.

## Display contract

- Installation metadata and runtime health are independent facts. A launch
  resolution or registration error is `failed`, not `not-installed`. A known
  absent installation remains `not-installed`.
- Main owns `KernelRuntimeSnapshot.restartRequired`; it is returned by status,
  list, catalog and events. Renderer refresh is not allowed to latch an old true
  value or lose it on a transient transport failure. Registration/uninstall
  clears it; process restart is not a substitute for app restart.
- Settings shows a localized app-restart explanation and disables kernel
  Start/Restart when app rebinding is required. Existing ready processes can
  still be stopped.
- A downloaded `desiredVersion` different from `activeVersion` is *pending
  activation*, not merely pending app restart. Stop that kernel, then use Update
  to activate the compatible signed catalog version. Restarting the app alone
  does not commit that pending package pointer. Other kernels remain usable.
- Post-commit registration failure still refreshes canonical installation facts
  and retains the launch error, so repair is available without claiming download
  failure or suggesting data deletion.

## Validation scope

Unit/component tests exercise both kernel resolvers and all three native Node
layouts, absent vs invalid installations, deferred activation, four-language
Settings notices, renderer refresh and mutation serialization. Real-child-process
supervisor contracts exercise late registration after a failed start, two live
kernels, same-kernel startup races, repair and deferred restart without replacing
the unaffected PID.

The user explicitly deferred the corresponding new Electron E2E on 2026-09-11.
Existing E2E files remain intact; these tests do not claim packaged-app or live
provider acceptance. Full validation results are recorded in TODO M23.

### Local evidence, 2026-09-11

- 49 focused tests passed, including delayed old-process exit and stale refresh
  races. Full unit/contract run: 2497 passed, 6 existing conditional skips.
- Typecheck, lint (0 errors / 7 existing Fast Refresh warnings), Vite/Main/preload/
  DataService builds, comms replay/compare, Harness CI (19 tests), task validation
  and dry-run passed.
- A separate local probe read only the installed DSH metadata, selected the real
  `0.1.3-alpha.1+clawx.13` artifact through the development resolver and checked
  the recorded file-manifest hash. Using that package's own Node and isolated
  temporary configuration/cache/data roots, it reproduced a missing-driver start,
  registered the launch, checked generation 1 readiness and health, restarted to
  generation 2 and checked health again. Both owned PIDs exited after stop.
  Two runs took 5307 ms and 514 ms. The probe sent no model requests and did not
  launch a kernel against the user's data directories.
- Probe source/bundle and the full test JSON report are local ignored artifacts
  under `test-results/`. This is not an Electron UI or real-provider E2E claim;
  no new E2E spec, app restart, database repair, commit or push was performed.
