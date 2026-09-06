# @clawx/dsh-rich-events

ClawX-owned projection from live `agent/assistant-stream` frames and v2 durable
DeepSeek Harness `SessionEvent` settlements to ACP updates. Live frames project
assistant text/private reasoning; settlements supply tool lifecycle, plan,
usage and titles. `assistant/chunk` is no longer a durable event. It never writes
history and never turns private reasoning into portable conversation context.

This package is applied as a DSH runtime overlay and is verified against a real
AgentLoop prompt in `tests/rich-events.spec.ts`.

The execution bridge owns retry/abandonment text replacement and deduplication.
Usage is emitted only at `assistant/message` or `assistant/attempt` settlement;
failed attempts take the last reported usage snapshot, never sum intermediate
snapshots. Missing fields remain unknown. Durable streams are not replayed as
live text. Do not mount an additional ACP publisher beside the execution bridge.
