const INLINE_CONTROL_ESCAPE_MAP: Readonly<Record<string, string>> = {
  '\0': '\\0',
  '\r': '\\r',
  '\n': '\\n',
  '\t': '\\t',
  '\v': '\\v',
  '\f': '\\f',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

function escapeInlineControlChars(value: string): string {
  let escaped = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const isInlineControl = codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029;
    if (!isInlineControl) {
      escaped += character;
      continue;
    }
    escaped += INLINE_CONTROL_ESCAPE_MAP[character]
      ?? (codePoint <= 0xff
        ? `\\x${codePoint.toString(16).padStart(2, '0')}`
        : `\\u${codePoint.toString(16).padStart(4, '0')}`);
  }
  return escaped;
}

/** Stable, kernel-neutral text representation used only for optimistic UI. */
export function canonicalResourceLinkPromptText(uri: string, title?: string): string {
  const safeTitle = title
    ? ` (${escapeInlineControlChars(title).replace(/[()[\]]/g, character => `\\${character}`)})`
    : '';
  const safeUri = uri ? escapeInlineControlChars(uri) : '';
  return safeUri ? `[Resource link${safeTitle}] ${safeUri}` : `[Resource link${safeTitle}]`;
}

/** Non-cryptographic diagnostic identity; never used for authorization. */
export function canonicalDiagnosticHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
