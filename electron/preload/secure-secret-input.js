import { contextBridge, ipcRenderer } from 'electron';

const entries = new Map();

function findHost(id) {
  return [...document.querySelectorAll('[data-clawx-secret-id]')]
    .find(element => element.getAttribute('data-clawx-secret-id') === id) ?? null;
}

function sync(entry) {
  entry.field.placeholder = entry.host.getAttribute('data-placeholder') ?? '';
  entry.field.disabled = entry.host.getAttribute('data-disabled') === 'true';
  const label = entry.host.getAttribute('aria-label');
  if (label) entry.field.setAttribute('aria-label', label);
  else entry.field.removeAttribute('aria-label');
}

function emitPresence(entry) {
  entry.host.dispatchEvent(new CustomEvent('secret-state-change', {
    bubbles: true,
    composed: true,
    detail: { hasValue: entry.field.value.length > 0 },
  }));
}

function mount(host) {
  const id = host.getAttribute('data-clawx-secret-id');
  if (!id) return null;
  const existing = entries.get(id);
  if (existing?.host === host) {
    sync(existing);
    return existing;
  }
  if (host.shadowRoot) throw new Error('Secure credential host already has an open shadow root');

  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { display: block; }
    input {
      box-sizing: border-box; width: 100%; height: 2.5rem; border-radius: .75rem;
      border: 1px solid var(--clawx-secret-border, rgba(127,127,127,.3));
      background: var(--clawx-secret-background, transparent);
      color: inherit; padding: 0 .75rem; font: inherit; outline: none;
    }
    input:focus { border-color: var(--clawx-secret-focus, currentColor); }
    input:disabled { cursor: not-allowed; opacity: .5; }
  `;
  const field = document.createElement('input');
  field.type = 'password';
  field.autocomplete = 'new-password';
  field.spellcheck = false;
  const entry = { host, field };
  field.addEventListener('input', () => emitPresence(entry));
  shadow.append(style, field);
  entries.set(id, entry);
  sync(entry);
  return entry;
}

function requireEntry(id) {
  const existing = entries.get(id);
  if (existing?.host.isConnected) return existing;
  const host = findHost(id);
  const entry = host ? mount(host) : null;
  if (!entry) throw new Error('Secure credential input is unavailable');
  return entry;
}

function scan() {
  for (const host of document.querySelectorAll('[data-clawx-secret-id]')) mount(host);
  for (const [id, entry] of entries) {
    if (!entry.host.isConnected) entries.delete(id);
  }
}

const observer = new MutationObserver(scan);
observer.observe(document, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['data-clawx-secret-id', 'data-placeholder', 'data-disabled', 'aria-label'],
});
scan();

const secureSecrets = {
  async stage(id) {
    const entry = requireEntry(id);
    if (!entry.field.value) return null;
    const result = await ipcRenderer.invoke('credential:stage', { value: entry.field.value });
    if (typeof result?.handle !== 'string') throw new Error('Secure credential staging failed');
    return result.handle;
  },
  clear(id) {
    const entry = requireEntry(id);
    entry.field.value = '';
    emitPresence(entry);
  },
  focus(id) {
    requireEntry(id).field.focus();
  },
};

if (process.env.CLAWX_E2E === '1') {
  secureSecrets.setValueForTesting = (id, value) => {
    const entry = requireEntry(id);
    entry.field.value = String(value);
    emitPresence(entry);
  };
}

contextBridge.exposeInMainWorld('clawxSecureSecrets', secureSecrets);
