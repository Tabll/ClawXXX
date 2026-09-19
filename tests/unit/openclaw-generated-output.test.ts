// @vitest-environment node
import { mkdtemp, mkdir, writeFile, symlink, truncate, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { collectGeneratedOutputs, deliveredToolMedia, generatedMediaDirectives } from '@electron/kernels/openclaw/generated-output';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('live generated output import', () => {
  it('accepts explicit MEDIA lines while excluding fenced examples, prose and ambiguous paths', () => {
    expect(generatedMediaDirectives('Example MEDIA: ignored.png\n```text\nMEDIA: secret.png\n```\nMEDIA: "my image.png"\nMEDIA: real.png\nMEDIA: real.png\nMEDIA: invalid path.png\n~~~\nMEDIA: example.png\n~~~'))
      .toEqual(['my image.png', 'real.png']);
  });

  it('requires successful internal message-tool delivery evidence', () => {
    const output = { details: { status: 'ok', deliveryStatus: 'sent', sourceReplySink: 'internal-ui', sourceReplyDeliveryMode: 'message_tool_only', sourceReply: { mediaUrl: '/tmp/image.png', mediaUrls: ['/tmp/image.png', '/tmp/report.pdf'] } } };
    expect(deliveredToolMedia(output)).toEqual(['/tmp/image.png', '/tmp/report.pdf']);
    expect(deliveredToolMedia({ ...output, isError: true })).toEqual([]);
    for (const key of ['status', 'deliveryStatus', 'sourceReplySink', 'sourceReplyDeliveryMode']) {
      expect(deliveredToolMedia({ details: { ...output.details, [key]: 'unknown' } })).toEqual([]);
    }
    expect(deliveredToolMedia({ text: 'MEDIA: /tmp/image.png' })).toEqual([]);
  });

  it('imports deduplicated scoped files, rejecting remote, traversal, symlink escapes, directories and oversized files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-generated-output-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const mediaRoot = join(root, 'media');
    await Promise.all([mkdir(workspace), mkdir(mediaRoot)]);
    const report = join(workspace, 'report 中文.txt');
    const image = join(mediaRoot, 'image.png');
    const outside = join(root, 'secret.txt');
    const large = join(workspace, 'too-large.bin');
    await Promise.all([writeFile(report, 'report'), writeFile(image, 'image'), writeFile(outside, 'secret'), writeFile(large, '')]);
    await truncate(large, 32 * 1024 * 1024 + 1);
    await symlink(outside, join(workspace, 'escape.txt'));
    if (process.platform !== 'win32') execFileSync('mkfifo', [join(workspace, 'named-pipe')]);
    const result = await collectGeneratedOutputs({ runId: 'run', workspace, mediaRoot, references: [
      'report 中文.txt', pathToFileURL(report).href, image, outside, '../secret.txt', 'escape.txt',
      workspace, large, 'named-pipe', 'missing.png', 'https://example.test/image.png', 'data:image/png;base64,aW1hZ2U=',
    ] });
    expect(result.map(item => ({ name: item.name, data: Buffer.from(item.data, 'base64').toString(), mimeType: item.mimeType })))
      .toEqual([{ name: 'report 中文.txt', data: 'report', mimeType: 'text/plain' }, { name: 'image.png', data: 'image', mimeType: 'image/png' }]);
    expect(result.map(item => item.blockId)).toEqual(['run:generated:0', 'run:generated:1']);
  });
});
