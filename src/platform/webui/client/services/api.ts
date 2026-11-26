import { escapeHtml } from '../base/html.js';
import { getLocale } from '../i18n/index.js';

export interface SendLimitFile {
  readonly data: string;
  readonly name: string;
}

export interface SendLimitBody {
  readonly text?: string;
  readonly files?: readonly SendLimitFile[];
}

export interface ApiClientOptions {
  readonly fetchFn?: typeof fetch;
  readonly getLocaleFn?: () => string;
  readonly retryDelayMs?: number;
  readonly onUnauthorized?: () => void;
}

export interface ApiClient {
  post(path: string, body: unknown, tries?: number, limit?: number): Promise<Response>;
  get(path: string, init?: RequestInit): Promise<Response>;
  getJson<T>(path: string, init?: RequestInit): Promise<T>;
  postJson<T>(path: string, body: unknown, tries?: number, limit?: number): Promise<T>;
}

export function text(s: unknown): string {
  return escapeHtml(s);
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// 15 s + 1 s per 64 KiB, capped at Node's 300 s http.Server.requestTimeout.
export function sendLimit(body: SendLimitBody): number {
  let n = (body.text || '').length;
  const files = body.files || [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file) n += file.data.length + file.name.length;
  }
  return Math.min(300000, 15000 + Math.round(n / 65.536));
}

function localeHeader(getLocaleFn: () => string): Record<string, string> {
  try {
    const loc = getLocaleFn();
    return loc ? { 'X-Fleetherd-Locale': loc } : {};
  } catch {
    return {};
  }
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const fetchFn = options.fetchFn ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const getLocaleFn = options.getLocaleFn ?? getLocale;
  const retryDelayMs = options.retryDelayMs ?? 700;

  function post(path: string, body: unknown, tries = 0, limit = 0): Promise<Response> {
    // Built first: JSON.stringify can throw synchronously before any timer or request is armed.
    const bytes = ArrayBuffer.isView(body);
    const headers: Record<string, string> = {
      'Content-Type': bytes ? 'application/octet-stream' : 'application/json',
      ...localeHeader(getLocaleFn),
    };
    const init: RequestInit = {
      method: 'POST',
      headers,
      body: bytes ? (body as BodyInit) : JSON.stringify(body),
      credentials: 'same-origin',
    };
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (limit && typeof AbortController === 'function') {
      const ctl = new AbortController();
      init.signal = ctl.signal;
      timer = setTimeout(() => {
        expired = true;
        ctl.abort();
      }, limit);
    }
    return fetchFn(path, init).then(
      (res) => {
        if (timer !== undefined) clearTimeout(timer);
        if (res.status === 401) options.onUnauthorized?.();
        if (!res.ok && res.status >= 500 && tries > 0) {
          return wait(retryDelayMs).then(() => post(path, body, tries - 1, limit));
        }
        return res;
      },
      (err) => {
        if (timer !== undefined) clearTimeout(timer);
        // Attempts given >60s carry uploads; fail once instead of restarting from byte 0.
        if (tries > 0 && !(expired && limit > 60000)) {
          return wait(retryDelayMs).then(() => post(path, body, tries - 1, limit));
        }
        throw err;
      },
    );
  }

  function get(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      ...localeHeader(getLocaleFn),
      ...(init.headers as Record<string, string> | undefined),
    };
    return fetchFn(path, { ...init, method: 'GET', headers, credentials: 'same-origin' }).then((res) => {
      if (res.status === 401) options.onUnauthorized?.();
      return res;
    });
  }

  async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await get(path, init);
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
    return (await res.json()) as T;
  }

  async function postJson<T>(path: string, body: unknown, tries = 0, limit = 0): Promise<T> {
    const res = await post(path, body, tries, limit);
    if (!res.ok) throw new Error(`POST ${path} failed (${res.status})`);
    return (await res.json()) as T;
  }

  return { post, get, getJson, postJson };
}

const defaultClient = createApiClient();

export function post(path: string, body: unknown, tries = 0, limit = 0): Promise<Response> {
  return defaultClient.post(path, body, tries, limit);
}
