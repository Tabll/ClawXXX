// @vitest-environment node

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const rendererRoot = resolve('src');

function sourceFiles(root = rendererRoot): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = resolve(root, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/.test(name) ? [path] : [];
  });
}

function violations(pattern: RegExp, files = sourceFiles()): string[] {
  return files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return source.split('\n').flatMap((line, index) => {
      pattern.lastIndex = 0;
      return pattern.test(line)
        ? [`${relative(process.cwd(), file)}:${index + 1}: ${line.trim()}`]
        : [];
    });
  });
}

describe('Renderer multi-kernel architecture boundary', () => {
  it('has no Gateway store/API, direct IPC, or loopback Gateway transport', () => {
    expect(violations(
      /hostApi\.gateway\b|useGatewayStore\b|stores\/gateway|ipcRenderer\.invoke|window\.electron\.ipcRenderer|https?:\/\/(?:127\.0\.0\.1|localhost):18789/i,
    )).toEqual([]);
  });

  it('uses only the Conversation API for durable chat history', () => {
    expect(violations(
      /hostApi\.sessions\b|hostApi\.chat\.loadAcpSession\b|invokeHost\(['"]sessions['"]/i,
    )).toEqual([]);

    const chatStore = readFileSync(resolve('src/stores/chat.ts'), 'utf8');
    const sessionStore = readFileSync(resolve('src/stores/acp-chat-session.ts'), 'utf8');
    expect(chatStore).toContain('hostApi.conversations.list');
    expect(chatStore).toContain('hostApi.conversations.search');
    expect(sessionStore).toContain('hostApi.conversations.get');
    expect(sessionStore).toContain('hostApi.chat.selectConversationKernel');
  });

  it('does not branch page, component, or store backend behavior on a concrete kernel ID', () => {
    const files = [
      ...sourceFiles(resolve('src/pages')),
      ...sourceFiles(resolve('src/components')),
      ...sourceFiles(resolve('src/stores')),
    ];
    expect(violations(
      /(?:kernelId|activeKernelId|selectedKernelId)\s*(?:===|!==|==|!=)\s*['"](?:openclaw|deepseek-harness)['"]|switch\s*\([^)]*kernel/i,
      files,
    )).toEqual([]);
  });

  it('keeps new multi-kernel surfaces on shared design tokens', () => {
    const files = [
      resolve('src/pages/Setup/index.tsx'),
      resolve('src/pages/Chat/index.tsx'),
      resolve('src/components/kernels/KernelStatus.tsx'),
      resolve('src/components/settings/KernelSettings.tsx'),
    ];
    expect(violations(
      /(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone)-|#[0-9a-f]{3,8}\b/i,
      files,
    )).toEqual([]);
    expect(readFileSync(resolve('src/components/settings/KernelSettings.tsx'), 'utf8'))
      .toContain('bg-surface-modal');
  });
});
