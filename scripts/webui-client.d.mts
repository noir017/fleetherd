// Types for webui-client.mjs, which the web UI's test harness imports from TypeScript
// (src/platform/webui/page.test-helpers.ts). The script itself stays plain .mjs like every other
// file here: the build runs it with node, no compile step.

/** One output: its content-hashed file name, and its text. */
export interface ClientFile {
  file: string;
  text: string;
}

export const APP_ENTRY: string;
export const BOOT_ENTRY: string;
export const STYLE_ENTRY: string;

/** The client script as source with its build-time markers filled. */
export function appSource(): Promise<string>;

/** Bundle the script and the stylesheet; with `outdir`, also write both there. */
export function buildClient(opts?: { outdir?: string }): Promise<{ app: ClientFile; boot: ClientFile; style: ClientFile }>;
