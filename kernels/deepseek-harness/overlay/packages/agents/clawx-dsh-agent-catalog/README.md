# `@clawx/dsh-agent-catalog`

Ephemeral DeepSeek Harness projection of ClawX canonical Agents. The package
does not persist a catalog or history in the runtime directory. Main replays
the desired catalog after every runtime generation starts, and every prompt
resolves an immutable version/workspace/model/persona composition before a
live DSH Agent handle is created.
