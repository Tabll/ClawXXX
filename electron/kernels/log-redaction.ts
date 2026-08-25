import { homedir } from 'node:os';

const SECRET_ASSIGNMENT = /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)\b\s*[:=]\s*([^\s,;]+)/gi;
const JSON_SECRET_ASSIGNMENT = /(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|credential)["']\s*:\s*)(["'])[^"']*\2/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PROVIDER_KEY = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g;
const URL_SECRET = /([?&](?:token|key|api_key|secret|password)=)[^&#\s]+/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bounded redaction shared by live logs, persisted logs and diagnostics export. */
export function redactDiagnosticText(value: unknown): string {
  let text = String(value ?? '');
  const home = homedir();
  if (home) text = text.replace(new RegExp(`${escapeRegExp(home)}(?:[/\\\\][^\\s"']*)?`, 'g'), '[redacted-path]');
  text = text
    .replace(/\/(?:Users|home)\/[^/\s"']+(?:\/[^\s"']*)?/g, '[redacted-path]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+(?:\\[^\s"']*)?/g, '[redacted-path]')
    .replace(BEARER, 'Bearer [redacted]')
    .replace(PROVIDER_KEY, '[redacted-key]')
    .replace(JSON_SECRET_ASSIGNMENT, '$1"[redacted]"')
    .replace(SECRET_ASSIGNMENT, (_match, name: string) => `${name}=[redacted]`)
    .replace(URL_SECRET, '$1[redacted]');
  return text.length > 16_384 ? `${text.slice(0, 16_384)}…[truncated]` : text;
}
