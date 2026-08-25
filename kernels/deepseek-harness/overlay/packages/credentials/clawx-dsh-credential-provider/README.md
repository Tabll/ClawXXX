# `@clawx/dsh-credential-provider`

Read-only `ctx.credentials` implementation for the ClawX-managed DeepSeek
Harness runtime. It resolves each model operation through the authenticated
Main-process CredentialBroker and never writes a DSH credential file, reads an
ambient API-key environment variable, or caches a secret between operations.
