// Generates the public, self-contained `dist/webui-plugin.d.ts` type declaration bundle for
// external fleetherd Web UI plugins (docs/webui-workbench-plan.md §6.4).
//
// Extracts live declarations via the TypeScript compiler API from:
//   - src/platform/webui/client/base/lifecycle.ts
//   - src/platform/webui/client/base/event.ts
//   - src/platform/webui/client/workbench/contracts.ts
//   - src/platform/webui/client/plugins/api.ts
//   - src/platform/webui/plugins/manifest.ts
//   - src/platform/webui/plugins/host.ts (when present; otherwise emits the §6.2 server contract)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LIFECYCLE_EXPORTS = new Set(['Disposable', 'DisposableStore']);
const EVENT_EXPORTS = new Set(['Listener', 'Event']);
const CONTRACTS_EXPORTS = new Set([
  'PartId',
  'Direction',
  'PanelPosition',
  'PanelInitContext',
  'PanelComponent',
  'PanelRef',
]);
const MANIFEST_EXPORTS = new Set(['BootPluginEntry']);

const LIT_HTML_TYPES = `export interface TemplateResult {
  readonly _$litType$: unknown;
  readonly strings: TemplateStringsArray;
  readonly values: readonly unknown[];
}

export interface RenderOptions {
  readonly host?: object;
  readonly renderBefore?: ChildNode | null;
  readonly creationScope?: { importNode(node: Node, deep?: boolean): Node };
  readonly isConnected?: boolean;
}

export interface RootPart {
  readonly parentNode: HTMLElement | DocumentFragment;
  readonly startNode: ChildNode;
  readonly endNode: ChildNode | null;
  setConnected(isConnected: boolean): void;
}

export type HtmlTemplateTag = (strings: TemplateStringsArray, ...values: unknown[]) => TemplateResult;
export type HtmlRenderFn = (value: unknown, container: HTMLElement | DocumentFragment, options?: RenderOptions) => RootPart;`;

const CLIENT_MODULE_TYPES = `export interface ClientPluginModule {
  readonly default?: WebuiPlugin;
  readonly plugin?: WebuiPlugin;
  readonly id?: string;
  readonly activate?: (ctx: PluginContext) => void | Promise<void>;
  readonly deactivate?: () => void;
}`;

const MANIFEST_DECLARATION = `export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly engines?: {
    readonly fleetherdWebui?: string;
  };
  readonly client?: string;
  readonly style?: string;
  readonly server?: string;
  readonly assets?: readonly string[];
}`;

const FALLBACK_SERVER_HOST_TYPES = `export interface PluginRouteRequest {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly params?: Readonly<Record<string, string>>;
  readonly query?: URLSearchParams;
  readonly body?: unknown;
}

export interface PluginRouteResponse {
  statusCode: number;
  setHeader(name: string, value: string | number | readonly string[]): unknown;
  end(chunk?: string | Uint8Array): unknown;
}

export type PluginRouteHandler = (
  req: PluginRouteRequest,
  res: PluginRouteResponse,
) => void | Promise<void>;

export interface TopicMessageSnapshot {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly timestamp?: number;
}

export interface TopicSnapshot extends TopicInfo {
  readonly messages?: readonly TopicMessageSnapshot[];
}

export type PluginHostEvent = 'topic' | 'message' | 'turn';

export interface PluginHost {
  readonly id: string;
  readonly config: unknown;
  readonly log: (msg: string) => void;
  readonly routes: {
    get(path: string, handler: PluginRouteHandler): void;
    post(path: string, handler: PluginRouteHandler): void;
  };
  readonly topics: {
    list(): TopicInfo[];
    get(id: string): TopicSnapshot | undefined;
    send(id: string, text: string): Promise<void>;
  };
  readonly events: {
    on(event: PluginHostEvent, cb: (payload: unknown) => void): Disposable;
    push(type: string, data: unknown): void;
  };
  readonly storage: {
    read(): Promise<unknown>;
    write(value: unknown): Promise<void>;
  };
}

export interface ServerPluginModule {
  activate(host: PluginHost): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}`;

function getStatementExportName(node) {
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name?.text;
  }
  if (ts.isVariableStatement(node)) {
    const decl = node.declarationList.declarations[0];
    return decl && ts.isIdentifier(decl.name) ? decl.name.text : undefined;
  }
  return undefined;
}

function isExportedStatement(node) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function extractDeclarations(dtsText, allowlist, transform) {
  const sf = ts.createSourceFile('in-memory.d.ts', dtsText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const blocks = [];
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) continue;
    if (!isExportedStatement(stmt)) continue;
    const name = getStatementExportName(stmt);
    if (allowlist && (!name || !allowlist.has(name))) continue;
    let text = dtsText.slice(stmt.getStart(sf), stmt.getEnd()).trim();
    if (transform) text = transform(text);
    blocks.push(text);
  }
  return blocks.join('\n\n');
}

function rewriteClientApi(text) {
  return text
    .replace(/typeof import\(["']lit-html["']\)\.html/g, 'HtmlTemplateTag')
    .replace(/typeof import\(["']lit-html["']\)\.render/g, 'HtmlRenderFn');
}

function emitDeclarationsInMemory(files) {
  const options = {
    declaration: true,
    emitDeclarationOnly: true,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    strict: true,
    skipLibCheck: true,
    types: [],
  };
  const program = ts.createProgram(files, options);
  const emitted = new Map();
  program.emit(undefined, (fileName, text) => {
    emitted.set(path.resolve(fileName), text);
  });
  return emitted;
}

function dtsPathFor(tsFile) {
  return path.resolve(tsFile.replace(/\.ts$/, '.d.ts'));
}

export function buildWebuiPluginTypes({ root = DEFAULT_ROOT, outFile = path.join(root, 'dist', 'webui-plugin.d.ts') } = {}) {
  const clientDir = path.join(root, 'src', 'platform', 'webui', 'client');
  const serverPluginsDir = path.join(root, 'src', 'platform', 'webui', 'plugins');

  const lifecycleTs = path.join(clientDir, 'base', 'lifecycle.ts');
  const eventTs = path.join(clientDir, 'base', 'event.ts');
  const contractsTs = path.join(clientDir, 'workbench', 'contracts.ts');
  const apiTs = path.join(clientDir, 'plugins', 'api.ts');
  const manifestTs = path.join(serverPluginsDir, 'manifest.ts');
  const serverHostTs = path.join(serverPluginsDir, 'host.ts');
  const hasServerHost = fs.existsSync(serverHostTs);

  const inputs = [lifecycleTs, eventTs, contractsTs, apiTs, manifestTs];
  if (hasServerHost) inputs.push(serverHostTs);

  const emitted = emitDeclarationsInMemory(inputs);
  const requireDts = (file) => {
    const dts = emitted.get(dtsPathFor(file));
    if (!dts) {
      throw new Error(`build-webui-plugin-types: failed to emit declarations for ${path.relative(root, file)}`);
    }
    return dts;
  };

  const lifecycleDecls = extractDeclarations(requireDts(lifecycleTs), LIFECYCLE_EXPORTS);
  const eventDecls = extractDeclarations(requireDts(eventTs), EVENT_EXPORTS);
  const contractsDecls = extractDeclarations(requireDts(contractsTs), CONTRACTS_EXPORTS);
  const apiDecls = extractDeclarations(requireDts(apiTs), undefined, rewriteClientApi);
  const bootEntryDecls = extractDeclarations(requireDts(manifestTs), MANIFEST_EXPORTS);

  let serverHostDecls = FALLBACK_SERVER_HOST_TYPES;
  if (hasServerHost) {
    const extracted = extractDeclarations(requireDts(serverHostTs), undefined);
    if (extracted.includes('interface PluginHost')) {
      serverHostDecls = extracted;
    }
  }

  const sections = [
    `// Generated by scripts/build-webui-plugin-types.mjs — do not edit manually.`,
    `// Public TypeScript contract for external fleetherd Web UI plugins.`,
    `// Base lifecycle & events`,
    lifecycleDecls,
    eventDecls,
    `// Workbench panel contracts`,
    contractsDecls,
    `// Template rendering primitives (lit-html compatible)`,
    LIT_HTML_TYPES,
    `// Frontend plugin API`,
    apiDecls,
    CLIENT_MODULE_TYPES,
    `// Plugin manifest & boot config`,
    MANIFEST_DECLARATION,
    bootEntryDecls,
    `// Server plugin host API`,
    serverHostDecls,
  ].filter(Boolean);

  const content = `${sections.join('\n\n')}\n`;

  if (/from\s+["']\.\.?\//.test(content) || /import\(["']lit-html["']\)/.test(content)) {
    throw new Error('build-webui-plugin-types: generated declaration file contains unresolved internal/external imports');
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, content, 'utf8');

  const bytes = Buffer.byteLength(content, 'utf8');
  const lines = content.split('\n').length - 1;
  return { outFile, bytes, lines, usedServerHostSource: hasServerHost };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = buildWebuiPluginTypes();
  console.log(
    `build-webui-plugin-types: wrote ${path.relative(DEFAULT_ROOT, info.outFile)} (${info.lines} lines, ${(info.bytes / 1024).toFixed(1)} KiB)`
  );
}
