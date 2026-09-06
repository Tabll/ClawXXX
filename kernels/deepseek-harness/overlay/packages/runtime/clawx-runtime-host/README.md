# @clawx/dsh-runtime-host

The host mounts DeepSeek Harness filesystem Skills only from its managed
`<dataDir>/skills` directory with default roots and symlink following disabled.
Canonical Skills are projected process-locally through
`@clawx/dsh-skill-catalog`; OpenClaw roots are never mounted or linked.

The only production process entrypoint for ClawX's DeepSeek Harness kernel. It
owns the DSH home lock and every live Agent handle, speaks
`clawx.kernel-stdio/v1`, sends diagnostics only to stderr, and never mounts a
native durable conversation backend.

For DSH 0.1.3-alpha.1, ClawX explicitly mounts and awaits the services in
`src/composition.ts`; the removed demo spine is not a dependency. Launch-time
HTTP proxy configuration comes from the captured process environment, without
loading a user `.env` or upstream app profile. Shutdown and failed startup
dispose the plugin world, proxy dispatcher and home lock.

`session.new` only validates the ClawX run identity; `session.prompt` creates a
transient per-run Agent from the canonical context supplied by Main. Terminal
settlement returns a versioned opaque checkpoint, disposes the Agent and leaves
Conversation history in ClawX SQLite. The runtime composes DSH's native tool
surface, not Code Mode or the DSH Web UI.

CI may set `CLAWX_KERNEL_SELF_TEST=1` and call `runtime.selfTest`. The probe
executes the packaged OS sandbox in workspace-write and read-only modes,
round-trips the real read/write tools and verifies approval/ask-user wiring is
fail-closed. Normal app launches do not set this flag, so the destructive probe
RPC is disabled in production use.
