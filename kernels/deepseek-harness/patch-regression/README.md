# DeepSeek Harness patch regression workspace

CI checks out the exact commit from `../source.json`, verifies its upstream `pnpm-lock.yaml`, applies the reviewed project-reference/lock patch, copies only the files listed in `../overlay.manifest.json`, and runs every command in `suite.json`. The resulting production deploy is then exercised through the canonical protocol/storage scenarios and scanned with `storage-contract-scan.mjs`.

The runtime-host dependency-closure test fails when an upstream workspace peer is no longer carried by the production deploy. The production-world test also boots the exact plugin composition without mounting DSH JSONL, SQLite-session, or settings-file persistence.

The five-target runtime build matrix sets `CLAWX_DSH_RUN_SANDBOX_SMOKE=1` for
the source suite, then repeats the probe against the extracted signed artifact
on macOS arm64/x64, Windows x64 and Linux arm64/x64. It must prove a real
workspace write, a kernel-enforced read-only denial, native file-tool
round-trip, interactive approval policy and orphan ask-user fail-closed
behavior. The flag is intentionally absent from normal runtime launches.

This workspace is build-time only. It is never shipped to, installed by, or executed on an end-user machine.
