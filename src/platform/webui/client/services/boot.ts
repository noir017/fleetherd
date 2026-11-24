export interface BootPluginConfig {
  readonly id: string;
  readonly version: string;
  readonly client?: string;
  readonly style?: string;
}

export interface BootConfig {
  readonly terminal: boolean;
  readonly terminalEnd: boolean;
  readonly files: boolean;
  readonly instructions: boolean;
  readonly password: boolean;
  readonly codeview: string | null;
  readonly instance: string;
  readonly build: string;
  readonly plugins: readonly BootPluginConfig[];
}

const DEFAULT_BOOT: BootConfig = {
  terminal: false,
  terminalEnd: false,
  files: false,
  instructions: false,
  password: true,
  codeview: null,
  instance: 'web',
  build: '',
  plugins: [],
};

function parseBootPlugins(raw: unknown): readonly BootPluginConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: BootPluginConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== 'string' || !rec.id || typeof rec.version !== 'string') continue;
    out.push({
      id: rec.id,
      version: rec.version,
      ...(typeof rec.client === 'string' && rec.client ? { client: rec.client } : {}),
      ...(typeof rec.style === 'string' && rec.style ? { style: rec.style } : {}),
    });
  }
  return out;
}

export function readBootConfig(doc: Pick<Document, 'getElementById'> = document): BootConfig {
  const el = doc.getElementById('boot-config');
  const raw = el?.textContent;
  if (!raw) return DEFAULT_BOOT;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_BOOT;
    return {
      terminal: Boolean(parsed.terminal),
      terminalEnd: Boolean(parsed.terminalEnd),
      files: Boolean(parsed.files),
      instructions: Boolean(parsed.instructions),
      password: parsed.password === undefined ? true : Boolean(parsed.password),
      codeview: typeof parsed.codeview === 'string' ? parsed.codeview : null,
      instance: typeof parsed.instance === 'string' && parsed.instance ? parsed.instance : 'web',
      build: typeof parsed.build === 'string' ? parsed.build : '',
      plugins: parseBootPlugins(parsed.plugins),
    };
  } catch {
    return DEFAULT_BOOT;
  }
}
