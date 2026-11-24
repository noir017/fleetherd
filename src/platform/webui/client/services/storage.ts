export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key?(index: number): string | null;
  readonly length?: number;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export class StorageService {
  private readonly _prefix: string;
  private readonly _backend: StorageLike | null;

  constructor(prefix = '', backend?: StorageLike | null) {
    this._prefix = prefix;
    this._backend = backend === undefined ? defaultStorage() : backend;
  }

  private _fullKey(key: string): string {
    return `${this._prefix}${key}`;
  }

  getRaw(key: string): string | null {
    if (!this._backend) return null;
    try {
      return this._backend.getItem(this._fullKey(key));
    } catch {
      return null;
    }
  }

  setRaw(key: string, value: string): boolean {
    if (!this._backend) return false;
    try {
      this._backend.setItem(this._fullKey(key), value);
      return true;
    } catch {
      return false;
    }
  }

  remove(key: string): boolean {
    if (!this._backend) return false;
    try {
      this._backend.removeItem(this._fullKey(key));
      return true;
    } catch {
      return false;
    }
  }

  getJson<T>(key: string): T | undefined {
    const raw = this.getRaw(key);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  setJson(key: string, value: unknown): boolean {
    try {
      return this.setRaw(key, JSON.stringify(value));
    } catch {
      return false;
    }
  }

  scope(namespace: string): StorageService {
    const sep = namespace.endsWith(':') ? '' : ':';
    return new StorageService(`${this._prefix}${namespace}${sep}`, this._backend);
  }

  keys(): string[] {
    if (!this._backend || typeof this._backend.key !== 'function' || typeof this._backend.length !== 'number') {
      return [];
    }
    const out: string[] = [];
    try {
      for (let i = 0; i < this._backend.length; i++) {
        const k = this._backend.key(i);
        if (k !== null && k.startsWith(this._prefix)) {
          out.push(k.slice(this._prefix.length));
        }
      }
    } catch {
      return out;
    }
    return out;
  }

  clear(): void {
    for (const key of this.keys()) {
      this.remove(key);
    }
  }
}
