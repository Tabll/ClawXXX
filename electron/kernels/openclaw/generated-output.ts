import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KernelOutputAttachment } from '@shared/kernels/contracts';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 32;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Strict live MEDIA directives; fenced examples and arbitrary prose are ignored. */
export function generatedMediaDirectives(text: string): string[] {
  const references: string[] = [];
  let fence: { character: string; length: number } | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { character: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.character && marker[1].length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = line.match(/^\s*MEDIA:\s*(.*?)\s*$/i);
    if (!match) continue;
    let value = match[1];
    if (value.startsWith('"') || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) continue;
      value = value.slice(1, -1);
    } else if (/\s/.test(value)) continue;
    if (value && value.length <= 4096) references.push(value);
  }
  return [...new Set(references)].slice(0, MAX_FILES);
}

/** Successful message-tool delivery evidence only, not inferred transcript data. */
export function deliveredToolMedia(output: unknown): string[] {
  const result = record(output);
  const details = record(result.details);
  if (result.isError === true || details.status !== 'ok' || details.deliveryStatus !== 'sent'
    || details.sourceReplySink !== 'internal-ui' || details.sourceReplyDeliveryMode !== 'message_tool_only') return [];
  const reply = record(details.sourceReply);
  return [...new Set([reply.mediaUrl, ...(Array.isArray(reply.mediaUrls) ? reply.mediaUrls : [])]
    .filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096))]
    .slice(0, MAX_FILES);
}

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function mimeType(path: string): string {
  const types: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain',
    '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  };
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export async function collectGeneratedOutputs(input: {
  runId: string;
  workspace: string;
  mediaRoot: string;
  references: Iterable<string>;
}): Promise<KernelOutputAttachment[]> {
  const roots = (await Promise.all([input.workspace, input.mediaRoot].map(path => realpath(path).catch(() => undefined))))
    .filter((path): path is string => !!path);
  const outputs: KernelOutputAttachment[] = [];
  const seenPaths = new Set<string>();
  let total = 0;
  for (const uri of [...new Set(input.references)].slice(0, MAX_FILES)) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (uri.length > 4096 || uri.includes('\0')) continue;
      const rawPath = uri.startsWith('file:') ? fileURLToPath(uri)
        : /^[a-z][a-z0-9+.-]*:/i.test(uri) && !/^[a-z]:[\\/]/i.test(uri) ? undefined
          : isAbsolute(uri) ? uri : resolve(input.workspace, uri);
      if (!rawPath) continue; // Remote URLs are never fetched by an import.
      const path = await realpath(rawPath);
      if (!roots.some(root => inside(root, path)) || seenPaths.has(path)) continue;
      if (!(await stat(path)).isFile()) continue;
      // NONBLOCK also prevents a file-to-FIFO race from hanging run completion.
      handle = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
      const opened = await handle.stat();
      const currentPath = await realpath(rawPath);
      const pathStat = await stat(currentPath);
      if (path !== currentPath || !roots.some(root => inside(root, currentPath)) || !opened.isFile()
        || opened.dev !== pathStat.dev || opened.ino !== pathStat.ino
        || opened.size > MAX_FILE_BYTES || total + opened.size > MAX_TOTAL_BYTES) continue;
      const data = Buffer.alloc(opened.size + 1);
      let length = 0;
      while (length < data.length) {
        const { bytesRead } = await handle.read(data, length, data.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      const final = await handle.stat();
      if (length !== opened.size || final.size !== opened.size || final.mtimeMs !== opened.mtimeMs
        || await realpath(rawPath) !== path) continue;
      seenPaths.add(path);
      total += length;
      outputs.push({
        blockId: `${input.runId}:generated:${outputs.length}`, mimeType: mimeType(path),
        data: data.subarray(0, length).toString('base64'), name: basename(path), sourceUri: uri,
      });
    } catch {
      // Missing, changed, out-of-scope or nonregular files never become grants.
    } finally { await handle?.close().catch(() => undefined); }
  }
  return outputs;
}

export function managedMediaRoot(stateRoot: string): string { return join(stateRoot, 'media'); }
