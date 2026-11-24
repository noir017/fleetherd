export interface BootConfig {
  readonly terminal: boolean;
  readonly terminalEnd: boolean;
  readonly files: boolean;
  readonly instructions: boolean;
  readonly password: boolean;
  readonly codeview: string | null;
  readonly instance: string;
  readonly build: string;
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
};

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
    };
  } catch {
    return DEFAULT_BOOT;
  }
}
