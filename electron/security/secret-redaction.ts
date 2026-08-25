const SECRET_FIELD = /(?:^|[-_])(api[-_]?key|secret|password|access[-_]?token|refresh[-_]?token|authorization|cookie|credential)(?:$|[-_])/i;
const SECRET_VALUE = /\b(?:sk|key|token|secret|bearer)[-_ ][A-Za-z0-9._~+/=-]{8,}\b/gi;

export const REDACTED_SECRET = '[REDACTED]' as const;

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SECRET_VALUE, REDACTED_SECRET);
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => (
      SECRET_FIELD.test(key) ? [key, REDACTED_SECRET] : [key, redactSecrets(entry)]
    )));
  }
  return value;
}
