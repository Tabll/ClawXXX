import type { CanonicalChannelTarget } from '@shared/domains/channels';
import type {
  ChannelConnectorStatus,
  ChannelCredentialValidation,
  ChannelInboundAttachment,
} from '../channel-runtime-contracts';

export const CONNECTOR_ATTACHMENT_LIMIT_BYTES = 25 * 1024 * 1024;
export const CONNECTOR_ATTACHMENT_BATCH_LIMIT_BYTES = 100 * 1024 * 1024;

export function requiredText(
  config: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = config[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

export function optionalText(
  config: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function requiredFields(
  config: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): ChannelCredentialValidation {
  const missing = fields.filter(field => {
    const value = config[field];
    return typeof value !== 'string' || !value.trim();
  });
  return missing.length === 0
    ? { valid: true }
    : { valid: false, errors: missing.map(field => `${field} is required`) };
}

export function safeConnectorError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/((?:token|secret|password|authorization|cookie)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .slice(0, 500);
}

export class ConnectorStatusTracker {
  private current: ChannelConnectorStatus;

  constructor(
    private readonly publish: (status: ChannelConnectorStatus) => Promise<void> | void,
    initial: ChannelConnectorStatus['state'] = 'connecting',
  ) {
    this.current = { state: initial, changedAt: new Date().toISOString() };
  }

  async set(state: ChannelConnectorStatus['state'], detail?: string): Promise<void> {
    this.current = {
      state,
      ...(detail ? { detail: detail.slice(0, 500) } : {}),
      changedAt: new Date().toISOString(),
    };
    await this.publish(this.current);
  }

  snapshot(): ChannelConnectorStatus {
    return { ...this.current };
  }
}

/** Bounded, in-memory directory only. It deliberately stores no messages. */
export class EphemeralTargetDirectory {
  private readonly entries = new Map<string, CanonicalChannelTarget>();

  constructor(private readonly limit = 2_000) {}

  observe(target: CanonicalChannelTarget): void {
    this.entries.delete(target.id);
    this.entries.set(target.id, target);
    while (this.entries.size > this.limit) {
      const first = this.entries.keys().next().value as string | undefined;
      if (!first) break;
      this.entries.delete(first);
    }
  }

  list(query?: string): CanonicalChannelTarget[] {
    const normalized = query?.trim().toLocaleLowerCase() ?? '';
    return [...this.entries.values()]
      .filter(target => !normalized
        || target.id.toLocaleLowerCase().includes(normalized)
        || target.displayName.toLocaleLowerCase().includes(normalized))
      .reverse();
  }
}

export async function downloadPortableAttachment(input: {
  url: string;
  mimeType?: string;
  fileName?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}): Promise<ChannelInboundAttachment> {
  const requested = new URL(input.url);
  if (requested.protocol !== 'https:') throw new Error('Connector attachments must use HTTPS');
  const response = await fetch(input.url, {
    headers: input.headers,
    signal: input.signal,
    redirect: 'follow',
  });
  if (response.url && new URL(response.url).protocol !== 'https:') {
    throw new Error('Connector attachment redirect was not HTTPS');
  }
  if (!response.ok) throw new Error(`Attachment download failed (${response.status})`);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > CONNECTOR_ATTACHMENT_LIMIT_BYTES) throw new Error('Attachment exceeds connector limit');
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > CONNECTOR_ATTACHMENT_LIMIT_BYTES) throw new Error('Attachment exceeds connector limit');
  return {
    data,
    mimeType: normalizeMimeType(input.mimeType ?? response.headers.get('content-type') ?? ''),
    ...(input.fileName ? { fileName: safeFileName(input.fileName) } : {}),
  };
}

export async function settledPortableAttachments(
  loaders: Array<() => Promise<ChannelInboundAttachment>>,
): Promise<ChannelInboundAttachment[]> {
  const attachments: ChannelInboundAttachment[] = [];
  let total = 0;
  for (const load of loaders.slice(0, 20)) {
    try {
      const attachment = await load();
      total += attachment.data.byteLength;
      if (total > CONNECTOR_ATTACHMENT_BATCH_LIMIT_BYTES) break;
      attachments.push(attachment);
    } catch {
      // Transport metadata may expire before download. The text message is
      // still admissible and the connector must not create its own retry log.
    }
  }
  return attachments;
}

export function normalizeMimeType(value: string): string {
  const normalized = value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : 'application/octet-stream';
}

export function safeFileName(value: string): string {
  return value.replace(/[\\/\0\r\n]/g, '_').slice(0, 255) || 'attachment';
}

export function unixTimestampIso(value: unknown): string {
  const numeric = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(numeric)) return new Date().toISOString();
  const millis = numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

export function runConnectorLoop(
  task: () => Promise<void>,
  onFailure: (message: string) => Promise<void> | void,
): void {
  void task().catch(error => onFailure(safeConnectorError(error)));
}

export function parseCsvSet(value: string | undefined): Set<string> {
  return new Set((value ?? '').split(/[\s,;]+/).map(entry => entry.trim().replace(/^@/, '')).filter(Boolean));
}
