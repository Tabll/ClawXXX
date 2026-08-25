# @clawx/dsh-acp-bridge

ClawX execution bridge for DeepSeek Harness. It receives only a canonical
Conversation snapshot supplied by the host, owns one live DSH Agent handle per
run, projects rich ordered events, and disposes the native session when the run
settles. It never reads or writes a native conversation catalog.

The optional checkpoint is an identity/configuration hint. Portable history is
always rehydrated from the ClawX DataService snapshot.
