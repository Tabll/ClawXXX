import assert from 'node:assert/strict';

export const PROBE_PROCESS_POLL_LIMIT = 8;
export const PROBE_PROCESS_POLL_MS = 5_000;
const execId = 'clawx-probe-exec';
const pollPrefix = 'clawx-probe-poll-';
const marker = 'CLAWX_TOOL_OK';

const toolCall = (id, name, args) => ({
  index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) },
});

function textOf(message) {
  if (typeof message.content === 'string') return message.content;
  assert.ok(Array.isArray(message.content), 'Probe tool result must contain text');
  return message.content.map(part => {
    assert.equal(part.type, 'text', 'Probe tool result has a non-text part');
    assert.equal(typeof part.text, 'string');
    return part.text;
  }).join('\n');
}

function resultFor(messages, id) {
  const results = messages.filter(message => message.role === 'tool' && message.tool_call_id === id);
  assert.equal(results.length, 1, `Expected exactly one result for owned probe call ${id}`);
  return textOf(results[0]);
}

/** Only the fixed exec and read-only polling of its returned session are allowed. */
export function nextOpenClawProbeToolCall(messages, command) {
  const calls = messages.filter(message => message.role === 'assistant')
    .flatMap(message => message.tool_calls ?? []);
  if (!calls.length) {
    assert.ok(!messages.some(message => message.role === 'tool'), `Probe lost tool call identity: ${JSON.stringify(messages.slice(-2)).slice(0, 2_000)}`);
    return toolCall(execId, 'exec', { command, background: true });
  }
  // The native provider adapter may normalize tool-call IDs. Bind its actual
  // IDs to the exact fixed command/arguments, not to our pre-adapter spelling.
  const executions = calls.filter(call => call.function?.name === 'exec');
  assert.equal(executions.length, 1, 'Probe must execute its fixed command exactly once');
  assert.equal(calls[0], executions[0], 'Probe execution must precede its polls');
  assert.ok(calls.every(call => typeof call.id === 'string' && call.id.length > 0), 'Probe tool call ID is missing');
  assert.equal(new Set(calls.map(call => call.id)).size, calls.length, 'Probe tool call IDs must be unique');
  assert.equal(executions[0].function?.name, 'exec');
  assert.deepEqual(JSON.parse(executions[0].function.arguments), { command, background: true });
  const output = [resultFor(messages, executions[0].id)];
  const session = output[0].match(/Command still running \(session ([A-Za-z0-9_-]+), pid (?:\d+|n\/a)\)/)?.[1];
  if (!session) {
    // Native foreground success contains stdout without an exit-code suffix.
    assert.ok(output[0].trim() === marker, `Unexpected foreground probe result: ${output[0].slice(0,2_000)}`);
    return undefined;
  }
  const polls = calls.slice(1);
  assert.ok(polls.length <= PROBE_PROCESS_POLL_LIMIT, 'Probe process poll limit exceeded');
  for (let index = 0; index < polls.length; index += 1) {
    const call = polls[index];
    assert.equal(call.function?.name, 'process');
    assert.deepEqual(JSON.parse(call.function.arguments), { action: 'poll', sessionId: session, timeout: PROBE_PROCESS_POLL_MS });
    const text = resultFor(messages, call.id);
    output.push(text);
    if (/Process exited with code 0\.\s*$/.test(text)) {
      assert.equal(index, polls.length - 1, 'Probe polled an already completed process');
      assert.ok(output.some(value => value.split(/\r?\n/).some(line => line.trim() === marker)), 'Approved tool must actually execute the fixed script');
      return undefined;
    }
    assert.ok(/Process still running\.\s*$/.test(text), `Probe process did not succeed: ${text.slice(0,2_000)}`);
  }
  assert.ok(polls.length < PROBE_PROCESS_POLL_LIMIT, 'Probe process did not finish within the bounded poll sequence');
  return toolCall(`${pollPrefix}${polls.length + 1}`, 'process', { action: 'poll', sessionId: session, timeout: PROBE_PROCESS_POLL_MS });
}
