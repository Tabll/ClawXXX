export async function fetchBoundedJson(url, { fetcher = fetch, headers = {}, allowMissing = false, maxBytes = 2 * 1024 * 1024,
  redirect = 'error' } = {}) {
  if (new URL(url).protocol !== 'https:') throw new Error('Release metadata requires HTTPS');
  const response = await fetcher(url, { headers, redirect, signal: AbortSignal.timeout(30_000) });
  if (response.url && new URL(response.url).protocol !== 'https:') {
    await response.body?.cancel(); throw new Error('Metadata redirect left HTTPS');
  }
  if (allowMissing && [404, 410].includes(response.status)) { await response.body?.cancel(); return undefined; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Metadata request failed (${response.status}): ${safeUrl(url)}`); }
  return JSON.parse((await readBoundedBody(response, maxBytes)).toString('utf8'));
}

export async function readBoundedBody(response, maxBytes) {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel(); throw new Error('Response exceeds its bounded byte budget');
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error('Response exceeds its bounded byte budget');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  return Buffer.concat(chunks);
}

export function safeUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}
