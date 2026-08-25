// @vitest-environment node

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DataServiceRpcServer } from '@electron/data/data-service-rpc-server';
import {
  ClawXDataServiceUtilityHost,
  type DataServiceProcessTransport,
} from '@electron/data/data-service-utility-host';
import { asConversationId, asRunId, asTurnId } from '@shared/conversations/contracts';
import type { DataServiceRpcMessage, DataServiceRpcRequest } from '@shared/data/rpc';
import { testAgentRouting } from '../../helpers/canonical-agent';

class LoopbackTransport implements DataServiceProcessTransport {
  private readonly messages = new Set<(message: DataServiceRpcMessage) => void>();
  private readonly exits = new Set<(error?: Error) => void>();
  private closed = false;

  constructor(private readonly server: DataServiceRpcServer) {}

  onMessage(listener: (message: DataServiceRpcMessage) => void): () => void {
    this.messages.add(listener);
    return () => this.messages.delete(listener);
  }

  onExit(listener: (error?: Error) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }

  start(): void {
    queueMicrotask(() => this.emit(this.server.ready()));
  }

  postMessage(message: DataServiceRpcRequest): void {
    queueMicrotask(() => {
      void this.server.handle(message).then(response => this.emit(response));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.server.close();
  }

  async crash(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.server.close();
    for (const listener of this.exits) listener(new Error('synthetic utility crash'));
  }

  private emit(message: DataServiceRpcMessage): void {
    if (this.closed) return;
    for (const listener of this.messages) listener(message);
  }
}

describe('versioned DataService utility-process host', () => {
  it('reconnects logical clients after an owner crash without replaying a pending write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clawx-data-rpc-'));
    const databasePath = join(root, 'state', 'clawx.sqlite');
    const transports: LoopbackTransport[] = [];
    const host = new ClawXDataServiceUtilityHost(() => {
      const transport = new LoopbackTransport(new DataServiceRpcServer(databasePath, join(root, 'blobs')));
      transports.push(transport);
      return transport;
    });
    await host.start();
    const main = await host.connect({ role: 'main' });
    await main.call('createConversation', {
      id: asConversationId('rpc-conversation'),
      title: 'RPC',
      createdAt: '2026-08-23T00:00:00.000Z',
    });
    expect(await main.call('getConversation', asConversationId('rpc-conversation')))
      .toEqual(expect.objectContaining({ id: 'rpc-conversation' }));

    await main.call('admitRun', {
      conversationId: asConversationId('rpc-conversation'),
      turnId: asTurnId('rpc-turn-before-crash'),
      runId: asRunId('rpc-run-before-crash'),
      routing: {
        kernelId: 'openclaw',
        kernelVersion: 'test',
        generation: 1,
        ...testAgentRouting('openclaw'),
        contextCompilerVersion: '1',
      },
      userBlocks: [{ id: 'rpc-block', type: 'text', visibility: 'portable', text: 'admitted' }],
      createdAt: '2026-08-23T00:00:01.000Z',
    });

    await transports[0]!.crash();
    expect(await main.call('getConversation', asConversationId('rpc-conversation')))
      .toEqual(expect.objectContaining({ id: 'rpc-conversation' }));
    expect(transports).toHaveLength(2);
    const recovered = await main.call<{ runs: Array<{ id: string; status: string }> }>(
      'exportConversation',
      asConversationId('rpc-conversation'),
    );
    expect(recovered.runs).toContainEqual(expect.objectContaining({
      id: 'rpc-run-before-crash',
      status: 'interrupted',
    }));
    await expect(main.call('admitRun', {
      conversationId: asConversationId('rpc-conversation'),
      turnId: asTurnId('rpc-turn-after-crash'),
      runId: asRunId('rpc-run-after-crash'),
      routing: {
        kernelId: 'deepseek-harness',
        kernelVersion: 'test',
        generation: 1,
        ...testAgentRouting('deepseek-harness'),
        contextCompilerVersion: '1',
      },
      userBlocks: [{ id: 'rpc-block-after', type: 'text', visibility: 'portable', text: 'recovered' }],
      createdAt: '2026-08-23T00:00:02.000Z',
    })).resolves.toBeUndefined();

    const kernel = await host.connect({ role: 'kernel', kernelId: 'openclaw', generation: 1 });
    await expect(kernel.call('createConversation', {
      id: asConversationId('forbidden'),
      createdAt: '2026-08-23T00:00:00.000Z',
    })).rejects.toThrow(/Only Main/);
    await host.close();
  });
});
