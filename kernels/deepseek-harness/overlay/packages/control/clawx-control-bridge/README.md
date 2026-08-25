# @clawx/dsh-control-bridge

Versioned, kernel-scoped control-plane adapter used by the single ClawX DSH
runtime host. It exposes health, agent/provider/skill projections, usage and
diagnostics, but deliberately has no conversation catalog API.

`lib/bin.js` is a bounded artifact-install smoke entrypoint. Production uses
the same bridge inside `@clawx/dsh-runtime-host`.
