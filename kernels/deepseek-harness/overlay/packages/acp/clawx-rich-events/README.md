# @clawx/dsh-rich-events

ClawX-owned projection from durable DeepSeek Harness `SessionEvent` records to
strict, ordered ACP session updates. It projects assistant text, private
reasoning, tool lifecycle, plan, usage and title events. It never writes
history and never turns private reasoning into portable conversation context.

This package is applied as a DSH runtime overlay and is verified against a real
AgentLoop prompt in `tests/rich-events.spec.ts`.
