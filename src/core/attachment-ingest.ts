/**
 * Inbound attachment download + text injection (platform-agnostic pure orchestration).
 *
 * Discord CDN URLs expire, so attachments are downloaded and cached. Readable text
 * documents are inlined into the agent prompt; binaries/images get a local path for
 * the agent to Read itself — and a picture the agent can be shown as one is ALSO handed back
 * as bytes (`images`), for a harness that takes it in the prompt (see `PromptImage`).
 *
 * Pure orchestration: aside from injected download/save (IO via DI), no side
 * effects, no clock, no globals/env — mocking download/save covers every branch.
 */

export interface AttachmentInput {
  /** `audio` is handled exactly as `file` here; only the voice path (core/voice.ts) tells them apart. */
  type: 'image' | 'audio' | 'file';
  url: string;
  name?: string;
  mime?: string;
  size?: number;
}

export interface AttachmentIngestConfig {
  /** Inline readable text into the prompt only when ≤ this many bytes. */
  maxInjectBytes: number;
  /** Don't download above this many bytes; emit a metadata line only. */
  maxDownloadBytes: number;
}

export interface AttachmentIngestDeps {
  /**
   * Download; returns the bytes plus whatever the transport learned about them. Throws on failure.
   *
   * `contentType` is the HTTP header where there is one. `name` is a filename discovered during
   * the fetch, which only a platform-specific fetcher can supply — the platforms that need one
   * (Lark) are exactly those whose message elements declare no name and no mime, so for them
   * this is the ONLY chance to learn either. Both are fallbacks: what the element declared wins.
   */
  download(url: string): Promise<{ bytes: Uint8Array; contentType?: string; name?: string }>;
  /** Persist to the cache dir; returns the final absolute path. */
  save(name: string, bytes: Uint8Array): Promise<string>;
}

export interface IngestedAttachments {
  /** Text block appended to the agent prompt (may be ''): inlined text + `[Attachment <name>: <path>]` lines. */
  promptText: string;
  /** Files persisted to disk (for logging / future use). */
  files: Array<{ path: string; name: string; mime?: string }>;
  /** Pictures that can go to the agent as pictures, in attachment order. Each also has its path line. */
  images: PromptImage[];
  /** Non-image (or held-back) persisted files that can go to an agent claiming `embeddedContext`. */
  promptFiles: PromptFile[];
  /** Pictures that did not make `images`, and why — for the daemon to log, since none of this is visible to anyone. */
  heldBack: Array<{ name: string; reason: string }>;
}

// ============================================================================
// Pictures the agent is shown, not just told about
// ============================================================================

/**
 * The image formats a model API takes: Anthropic's vision docs list exactly these four, and
 * OpenAI's are the same set. Anything else a platform sends as a picture (HEIC off an iPhone,
 * BMP, TIFF, SVG) stays a path.
 */
export type PromptImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** One picture to put in front of the agent as a picture, beside the path line naming it. */
export interface PromptImage {
  name: string;
  /** Read off the bytes (see `sniffImageType`), never taken from what the platform declared. */
  mimeType: PromptImageType;
  bytes: Uint8Array;
}

/** One non-image persisted file to forward as an ACP embedded resource when the agent supports it. */
export interface PromptFile {
  name: string;
  path: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** Largest single file sent inline as an ACP embedded resource blob (10 MB raw). */
export const MAX_PROMPT_FILE_BYTES = 10_000_000;
/** Most non-image file bytes one prompt carries inline (20 MB raw). */
export const MAX_PROMPT_FILE_TOTAL_BYTES = 20_000_000;

/**
 * Largest picture sent as a picture: 5,000,000 bytes once base64'd, the strictest per-image cap
 * among the places a request may end up (Anthropic's direct API takes more; Bedrock and Vertex
 * stop at 5 MB — platform.claude.com vision docs, read 2026-10-09). The relay in front of the
 * model is the operator's and its upstream is not knowable from here, so the smallest one wins.
 *
 * Past it the picture is still saved and named by path, which is how every picture went before.
 */
export const MAX_PROMPT_IMAGE_BYTES = 3_750_000;

/**
 * Most picture bytes one prompt carries, 20 MB once base64'd. A request is capped at 32 MB and
 * the session's history rides in the same request, so one merged batch of screenshots must not
 * spend all of it. Pictures past it go by path, in order: the first ones fit, the rest do not.
 */
export const MAX_PROMPT_IMAGE_TOTAL_BYTES = 15_000_000;

/**
 * What the bytes ARE, from their magic numbers; `undefined` for anything outside PromptImageType.
 *
 * Not the declared mime, and that is load-bearing rather than tidy. Anthropic's API answers 400
 * when an image block's `media_type` disagrees with its data, and a prompt the harness has already
 * written into its history is re-sent on every later request — so one mislabelled screenshot (a
 * platform that calls every photo `image/jpeg`, a browser guessing from a renamed file) would fail
 * that turn and every turn after it in the same session.
 */
export function sniffImageType(bytes: Uint8Array): PromptImageType | undefined {
  const at = (i: number, ...sig: number[]): boolean => sig.every((b, k) => bytes[i + k] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return undefined;
}

/**
 * Pick, in order, the pictures that go in as pictures, within both caps.
 *
 * Only what was sent AS a picture — the element said `image`, or its type did. A PNG sent as a
 * document is a file the user wanted handled as one, and showing it would spend a few thousand
 * tokens of context on something nobody asked to be looked at.
 */
function pickImages(
  saved: Array<{ name: string; path: string; type: AttachmentInput['type']; mime?: string; bytes: Uint8Array }>
): Pick<IngestedAttachments, 'images' | 'heldBack'> & { pickedIndices: Set<number> } {
  const images: PromptImage[] = [];
  const heldBack: IngestedAttachments['heldBack'] = [];
  const pickedIndices = new Set<number>();
  let total = 0;
  for (let i = 0; i < saved.length; i++) {
    const f = saved[i]!;
    if (f.type !== 'image' && !f.mime?.toLowerCase().startsWith('image/')) continue;
    const mimeType = sniffImageType(f.bytes);
    if (!mimeType) {
      heldBack.push({ name: f.name, reason: 'not png/jpeg/gif/webp' });
    } else if (f.bytes.length > MAX_PROMPT_IMAGE_BYTES) {
      heldBack.push({ name: f.name, reason: `${f.bytes.length} bytes, over ${MAX_PROMPT_IMAGE_BYTES}` });
    } else if (total + f.bytes.length > MAX_PROMPT_IMAGE_TOTAL_BYTES) {
      heldBack.push({ name: f.name, reason: `the message's pictures pass ${MAX_PROMPT_IMAGE_TOTAL_BYTES} bytes` });
    } else {
      total += f.bytes.length;
      images.push({ name: f.name, mimeType, bytes: f.bytes });
      pickedIndices.add(i);
    }
  }
  return { images, heldBack, pickedIndices };
}

/** Pick persisted non-image (or held-back) files within size caps for agents claiming `embeddedContext`. */
function pickPromptFiles(
  saved: Array<{ name: string; path: string; type: AttachmentInput['type']; mime?: string; bytes: Uint8Array }>,
  pickedImages: ReadonlySet<number>
): PromptFile[] {
  const out: PromptFile[] = [];
  let total = 0;
  for (let i = 0; i < saved.length; i++) {
    if (pickedImages.has(i)) continue;
    const f = saved[i]!;
    if (f.bytes.length === 0 || f.bytes.length > MAX_PROMPT_FILE_BYTES) continue;
    if (total + f.bytes.length > MAX_PROMPT_FILE_TOTAL_BYTES) continue;
    total += f.bytes.length;
    out.push({
      name: f.name,
      path: f.path,
      mimeType: f.mime?.split(';')[0]?.trim() || 'application/octet-stream',
      bytes: f.bytes,
    });
  }
  return out;
}

// ============================================================================
// "readable text" check (pure, by mime or filename extension)
// ============================================================================

/** Extensions (with dot) treated as readable text: common plain-text + code files. */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.log',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.java', '.go', '.rs', '.c', '.cpp', '.cc', '.h', '.hpp',
  '.sh', '.bash', '.zsh', '.html', '.htm', '.css', '.scss',
  '.xml', '.toml', '.ini', '.env', '.sql', '.rb', '.php', '.kt', '.swift',
]);

/** Lowercase extension (with dot) of a filename; '' when none. */
function extOf(name: string | undefined): string {
  if (!name) return '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot).toLowerCase();
}

/**
 * Whether an attachment is "readable text":
 *  - mime matches `text/*`, `application/json`, `application/xml`, or a `+json`/`+xml`
 *    structured suffix (e.g. `application/ld+json`, `image/svg+xml`).
 *  - otherwise the filename extension is in TEXT_EXTENSIONS.
 *
 * Pure: looks only at mime and name.
 */
export function isReadableText(mime: string | undefined, name: string | undefined): boolean {
  if (mime) {
    const m = (mime.toLowerCase().split(';')[0] ?? '').trim(); // strip `; charset=...`
    if (m.startsWith('text/')) return true;
    if (m === 'application/json' || m === 'application/xml') return true;
    if (m.endsWith('+json') || m.endsWith('+xml')) return true;
  }
  return TEXT_EXTENSIONS.has(extOf(name));
}

const decoder = new TextDecoder('utf-8');

/** Fence language tag for inlining: extension (sans dot), else empty. */
function fenceLang(name: string | undefined): string {
  const ext = extOf(name);
  if (ext) return ext.slice(1); // drop the dot
  return '';
}

/**
 * Display filename fallback.
 *
 * A `data:` URL needs its own answer: it IS the file rather than a path to one, so the last
 * `/`-separated chunk — which is what names an ordinary URL — is a slice of base64, and a photo
 * would be labelled with a kilobyte of it. Satori's adapters produce these for platforms whose
 * media sits behind an authenticated API (adapter-telegram inlines every inbound photo this way),
 * so this is the normal case for a Telegram image, not an edge one.
 */
function displayName(att: AttachmentInput): string {
  if (att.name && att.name.length > 0) return att.name;
  if (isInlineUrl(att.url)) {
    const mime = att.mime ?? /^data:([^;,]+)/.exec(att.url)?.[1];
    const ext = mime?.split('/')[1]?.replace(/\+.*$/, '');
    const kind = mime?.startsWith('image/') ? 'image' : 'file';
    return ext ? `${kind}.${ext}` : kind;
  }
  return att.url.split('/').pop() || att.url;
}

/** Whether the "URL" is really the bytes themselves. */
function isInlineUrl(url: string): boolean {
  return url.startsWith('data:');
}

/**
 * A URL short enough to name in a prompt line.
 *
 * The failure lines quote the URL so the agent can retry or report it, which is right for an http
 * one and catastrophic for a `data:` one: quoting it would paste the entire file into the prompt as
 * base64 — the exact payload the size limits above exist to keep out, arriving through the error
 * path instead.
 */
function displayUrl(url: string): string {
  if (!isInlineUrl(url)) return url;
  const comma = url.indexOf(',');
  return `${comma > 0 ? url.slice(0, comma) : 'data:'},…(${url.length} chars inline)`;
}

/**
 * Process each attachment, build promptText, collect persisted files.
 *
 * Rules:
 *  - Readable text with size (or downloaded length) ≤ maxInjectBytes: inline as a
 *    fenced block with language tag, labeled with the filename. Re-decided after the download
 *    when the transport reported a name/mime the element did not carry (Lark).
 *  - Otherwise (binary/image/oversized text):
 *    - size unknown or ≤ maxDownloadBytes: download and save, append an `[Attachment <name>: <path>]` line.
 *    - size > maxDownloadBytes: don't download, append an "too large, not downloaded" line.
 *  - A single download error doesn't stop the rest; degrades to a "download failed" line.
 *  - Empty array → promptText is ''.
 *  - Of what was saved, each picture in a format and size a model takes is also returned in
 *    `images`; the rest are listed in `heldBack` with the reason (see pickImages).
 */
export async function ingestAttachments(
  atts: AttachmentInput[],
  cfg: AttachmentIngestConfig,
  deps: AttachmentIngestDeps
): Promise<IngestedAttachments> {
  const lines: string[] = [];
  const files: IngestedAttachments['files'] = [];
  const saved: Parameters<typeof pickImages>[0] = [];

  for (const att of atts) {
    const name = displayName(att);
    try {
      const readable = isReadableText(att.mime, att.name);

      // Readable text path: download and inline if ≤ maxInjectBytes. When size is
      // unknown, still try inlining and decide by byte length after download.
      if (readable && (att.size === undefined || att.size <= cfg.maxInjectBytes)) {
        const { bytes } = await deps.download(att.url);
        if (bytes.length <= cfg.maxInjectBytes) {
          const text = decoder.decode(bytes);
          const lang = fenceLang(att.name);
          lines.push(`Attachment ${name}:\n\`\`\`${lang}\n${text}\n\`\`\``);
          continue;
        }
        // Exceeded maxInjectBytes after download: persist and give the path.
        const savedPath = await saveAndRecord(att, name, bytes, deps, files, lines);
        saved.push({ name, path: savedPath, type: att.type, mime: att.mime, bytes });
        continue;
      }

      // Oversized text (known size > maxInjectBytes), binary, image: by download threshold.
      if (att.size !== undefined && att.size > cfg.maxDownloadBytes) {
        lines.push(`[Attachment ${name} is too large (${att.size} bytes), not downloaded. URL: ${displayUrl(att.url)}]`);
        continue;
      }
      // size unknown or ≤ maxDownloadBytes: download and persist.
      const got = await deps.download(att.url);
      // Name and mime may arrive WITH the bytes rather than with the element: a Feishu image
      // declares neither, so before this the agent got a path ending in a bare resource key.
      // Knowing them changes two decisions — what the saved file is called, and whether this was
      // readable text after all — so both are re-taken here rather than only logged.
      const resolvedName = att.name ?? got.name;
      const resolvedMime = att.mime ?? got.contentType;
      const display = resolvedName ?? name;
      if (
        !readable &&
        isReadableText(resolvedMime, resolvedName) &&
        got.bytes.length <= cfg.maxInjectBytes
      ) {
        const text = decoder.decode(got.bytes);
        lines.push(`Attachment ${display}:\n\`\`\`${fenceLang(resolvedName)}\n${text}\n\`\`\``);
        continue;
      }
      const savedPath = await saveAndRecord(
        { ...att, ...(resolvedName ? { name: resolvedName } : {}), ...(resolvedMime ? { mime: resolvedMime } : {}) },
        display,
        got.bytes,
        deps,
        files,
        lines
      );
      saved.push({ name: display, path: savedPath, type: att.type, mime: resolvedMime, bytes: got.bytes });
    } catch {
      // Single failure degrades to a line, doesn't affect the rest.
      lines.push(`[Attachment ${name} failed to download. URL: ${displayUrl(att.url)}]`);
    }
  }

  const { images, heldBack, pickedIndices } = pickImages(saved);
  const promptFiles = pickPromptFiles(saved, pickedIndices);
  return { promptText: lines.join('\n'), files, images, promptFiles, heldBack };
}

/**
 * Persist, append an `[Attachment <name>: <path>]` line, record the file. download is done by the caller.
 *
 * The line states where the file is and nothing else. It used to add "use the Read tool to view it
 * when needed", which is the gateway telling the agent how to work — and named a tool agy does not
 * have. An agent handed a path knows what to do with one.
 *
 * A picture that also goes in as a picture (`images`) keeps exactly this line, with nothing added
 * like "shown above": the agent sees the picture and is told where its file is, which are both
 * facts, and how they relate is not the gateway's to narrate.
 */
async function saveAndRecord(
  att: AttachmentInput,
  name: string,
  bytes: Uint8Array,
  deps: AttachmentIngestDeps,
  files: IngestedAttachments['files'],
  lines: string[]
): Promise<string> {
  const path = await deps.save(name, bytes);
  files.push({ path, name, mime: att.mime });
  const mimeNote = att.mime ? ` (${att.mime})` : '';
  lines.push(`[Attachment ${name}: ${path}${mimeNote}]`);
  return path;
}
