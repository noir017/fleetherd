import { describe, it, expect, vi } from 'vitest';
import {
  ingestAttachments,
  isReadableText,
  MAX_PROMPT_IMAGE_BYTES,
  MAX_PROMPT_IMAGE_TOTAL_BYTES,
  sniffImageType,
  type AttachmentInput,
  type AttachmentIngestConfig,
  type AttachmentIngestDeps,
} from './attachment-ingest.js';

const CFG: AttachmentIngestConfig = {
  maxInjectBytes: 100,
  maxDownloadBytes: 1000,
};

/** Build downloaded bytes from a string. */
function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Mock deps: download returns by url→content map; save returns a fake path and records the call. */
function makeDeps(opts: {
  contents?: Record<string, { text?: string; bytes?: Uint8Array; contentType?: string; name?: string }>;
  downloadError?: Record<string, boolean>;
} = {}): AttachmentIngestDeps & { saveCalls: Array<{ name: string; bytes: Uint8Array }> } {
  const saveCalls: Array<{ name: string; bytes: Uint8Array }> = [];
  return {
    saveCalls,
    download: vi.fn(async (url: string) => {
      if (opts.downloadError?.[url]) throw new Error('network error');
      const c = opts.contents?.[url];
      if (!c) throw new Error(`mock not configured for url: ${url}`);
      return { bytes: c.bytes ?? bytesOf(c.text ?? ''), contentType: c.contentType, name: c.name };
    }),
    save: vi.fn(async (name: string, bytes: Uint8Array) => {
      saveCalls.push({ name, bytes });
      return `/cache/${name}`;
    }),
  };
}

describe('isReadableText', () => {
  it('matches text/*, json/xml, and structured suffixes by mime', () => {
    expect(isReadableText('text/plain', undefined)).toBe(true);
    expect(isReadableText('text/markdown; charset=utf-8', undefined)).toBe(true);
    expect(isReadableText('application/json', undefined)).toBe(true);
    expect(isReadableText('application/xml', undefined)).toBe(true);
    expect(isReadableText('application/ld+json', undefined)).toBe(true);
    expect(isReadableText('image/svg+xml', undefined)).toBe(true);
  });

  it('matches common text/code files by extension', () => {
    expect(isReadableText(undefined, 'notes.md')).toBe(true);
    expect(isReadableText(undefined, 'main.ts')).toBe(true);
    expect(isReadableText(undefined, 'data.csv')).toBe(true);
  });

  it('binary mime / unknown extension → false', () => {
    expect(isReadableText('image/png', 'pic.png')).toBe(false);
    expect(isReadableText('application/octet-stream', 'blob.bin')).toBe(false);
    expect(isReadableText(undefined, undefined)).toBe(false);
  });
});

describe('ingestAttachments', () => {
  it('empty array → empty promptText, no files', async () => {
    const deps = makeDeps();
    const res = await ingestAttachments([], CFG, deps);
    expect(res.promptText).toBe('');
    expect(res.files).toEqual([]);
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });

  it('readable text document → inlined fenced block + content, not persisted', async () => {
    const att: AttachmentInput = { type: 'file', url: 'u1', name: 'a.md', mime: 'text/markdown', size: 10 };
    const deps = makeDeps({ contents: { u1: { text: '# Hello\nworld' } } });
    const res = await ingestAttachments([att], CFG, deps);

    expect(res.promptText).toContain('Attachment a.md');
    expect(res.promptText).toContain('```md');
    expect(res.promptText).toContain('# Hello\nworld');
    expect(res.promptText).toContain('```');
    expect(deps.save).not.toHaveBeenCalled();
    expect(res.files).toEqual([]);
  });

  it('text over maxInjectBytes → not inlined, persisted with a path', async () => {
    const big = 'x'.repeat(200); // > maxInjectBytes(100)
    // Unknown size exercises the "download then decide by byte length" path.
    const att: AttachmentInput = { type: 'file', url: 'u2', name: 'big.log', mime: 'text/plain' };
    const deps = makeDeps({ contents: { u2: { text: big } } });
    const res = await ingestAttachments([att], CFG, deps);

    expect(res.promptText).not.toContain('```');
    expect(res.promptText).toContain('[Attachment big.log: /cache/big.log (text/plain)]');
    expect(deps.save).toHaveBeenCalledOnce();
    expect(res.files).toEqual([{ path: '/cache/big.log', name: 'big.log', mime: 'text/plain' }]);
  });

  it('binary/image → persisted path line', async () => {
    const att: AttachmentInput = { type: 'image', url: 'u3', name: 'pic.png', mime: 'image/png', size: 500 };
    const deps = makeDeps({ contents: { u3: { text: 'PNGDATA' } } });
    const res = await ingestAttachments([att], CFG, deps);

    expect(res.promptText).toBe('[Attachment pic.png: /cache/pic.png (image/png)]');
    // Where the file is, and nothing about how to work with it: no tool named, no instruction.
    expect(res.promptText).not.toMatch(/Read tool|use the/i);
    expect(deps.save).toHaveBeenCalledOnce();
    expect(res.files[0]).toEqual({ path: '/cache/pic.png', name: 'pic.png', mime: 'image/png' });
  });

  it('over maxDownloadBytes → not downloaded, metadata line only', async () => {
    const att: AttachmentInput = { type: 'file', url: 'u4', name: 'huge.zip', mime: 'application/zip', size: 5000 };
    const deps = makeDeps();
    const res = await ingestAttachments([att], CFG, deps);

    expect(res.promptText).toContain('huge.zip is too large (5000 bytes), not downloaded');
    expect(res.promptText).toContain('URL: u4');
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
    expect(res.files).toEqual([]);
  });

  it('one attachment download throws → degraded line, others unaffected', async () => {
    const bad: AttachmentInput = { type: 'image', url: 'bad', name: 'x.png', mime: 'image/png', size: 100 };
    const good: AttachmentInput = { type: 'file', url: 'good', name: 'ok.txt', mime: 'text/plain', size: 5 };
    const deps = makeDeps({
      contents: { good: { text: 'hi' } },
      downloadError: { bad: true },
    });
    const res = await ingestAttachments([bad, good], CFG, deps);

    expect(res.promptText).toContain('[Attachment x.png failed to download. URL: bad]');
    // good is still inlined (readable text ≤ maxInjectBytes).
    expect(res.promptText).toContain('Attachment ok.txt');
    expect(res.promptText).toContain('hi');
  });

  it('multiple attachments processed individually then joined', async () => {
    const a: AttachmentInput = { type: 'file', url: 'a', name: 'a.txt', mime: 'text/plain', size: 2 };
    const b: AttachmentInput = { type: 'image', url: 'b', name: 'b.png', mime: 'image/png', size: 3 };
    const deps = makeDeps({ contents: { a: { text: 'hi' }, b: { text: 'png' } } });
    const res = await ingestAttachments([a, b], CFG, deps);

    expect(res.promptText).toContain('a.txt');
    expect(res.promptText).toContain('[Attachment b.png: ');
    expect(res.files).toHaveLength(1); // only b persisted
  });
});

/**
 * A name/mime the TRANSPORT reports rather than the element.
 *
 * Lark is why this exists: its media elements declare neither, so before the platform fetch
 * override an inbound Feishu file was saved under the tail of an `internal:` URL — a bare
 * resource key with no extension — and a text file was never inlined at all.
 */
describe('ingestAttachments · metadata discovered during the download', () => {
  const url = 'internal:lark/cli_x/im/v1/messages/om_1/resources/file_v2_z?type=file';

  it('names the saved file after what the transport reported', async () => {
    const deps = makeDeps({ contents: { [url]: { text: 'PDFDATA', name: 'report.pdf' } } });
    const atts: AttachmentInput[] = [{ type: 'file', url }];
    const res = await ingestAttachments(atts, CFG, deps);
    expect(deps.saveCalls[0]!.name).toBe('report.pdf');
    expect(res.promptText).toContain('[Attachment report.pdf: /cache/report.pdf]');
    // The old behavior: the URL tail, query string and all.
    expect(res.promptText).not.toContain('file_v2_z?type=file');
  });

  it('inlines text the element said nothing about, once the name reveals it', async () => {
    const deps = makeDeps({ contents: { [url]: { text: '# hi', name: 'notes.md' } } });
    const res = await ingestAttachments([{ type: 'file', url }], CFG, deps);
    expect(res.promptText).toBe('Attachment notes.md:\n```md\n# hi\n```');
    expect(deps.saveCalls).toHaveLength(0);
  });

  it('a reported mime alone is enough to inline it', async () => {
    const deps = makeDeps({ contents: { [url]: { text: 'plain', contentType: 'text/plain' } } });
    const res = await ingestAttachments([{ type: 'file', url }], CFG, deps);
    expect(res.promptText).toContain('```\nplain\n```');
  });

  it('what the element declared still wins', async () => {
    const deps = makeDeps({ contents: { [url]: { text: 'x'.repeat(5), name: 'transport.bin' } } });
    await ingestAttachments([{ type: 'file', url, name: 'element.bin' }], CFG, deps);
    expect(deps.saveCalls[0]!.name).toBe('element.bin');
  });

  it('a reported name does not defeat the inject cap', async () => {
    // Readable and named, but over maxInjectBytes ⇒ saved, not inlined (the pre-existing rule).
    const deps = makeDeps({ contents: { [url]: { text: 'y'.repeat(200), name: 'big.md' } } });
    const res = await ingestAttachments([{ type: 'file', url }], CFG, deps);
    expect(deps.saveCalls[0]!.name).toBe('big.md');
    expect(res.promptText).toContain('[Attachment big.md: ');
  });
});

/**
 * Attachments whose "URL" is the file itself.
 *
 * Satori's adapters inline media from platforms that keep it behind an authenticated API —
 * adapter-telegram hands over every inbound photo as `data:<mime>;base64,…`. Two things that read
 * naturally for an http URL become destructive for one of these: naming the attachment after its
 * last path segment, and quoting the URL back into the prompt when something fails.
 */
describe('ingestAttachments · inline data: URLs', () => {
  const PHOTO = 'data:image/jpeg;base64,/9j/4AABBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

  it('names an inline image from its type instead of a slice of base64', async () => {
    const att: AttachmentInput = { type: 'image', url: PHOTO };
    const deps = makeDeps({ contents: { [PHOTO]: { text: 'jpegbytes' } } });
    const res = await ingestAttachments([att], CFG, deps);

    expect(res.files[0]?.name).toBe('image.jpeg');
    expect(res.promptText).toContain('image.jpeg');
    expect(res.promptText).not.toContain('/9j/4AAB');
  });

  it('does not paste the whole file into the prompt when a download fails', async () => {
    // The failure line quotes the URL so the agent can retry it. For a data: URL that quote IS the
    // file — the payload the size limits exist to keep out, arriving through the error path.
    const att: AttachmentInput = { type: 'image', url: PHOTO };
    const deps = makeDeps({ downloadError: { [PHOTO]: true } });
    const res = await ingestAttachments([att], CFG, deps);

    expect(res.promptText).toContain('failed to download');
    expect(res.promptText).toContain('data:image/jpeg;base64');
    expect(res.promptText).not.toContain('/9j/4AAB');
  });

  it('does not paste it into the oversized line either', async () => {
    const att: AttachmentInput = { type: 'image', url: PHOTO, size: 99_999 };
    const res = await ingestAttachments([att], CFG, makeDeps());

    expect(res.promptText).toContain('too large');
    expect(res.promptText).not.toContain('/9j/4AAB');
  });

  it('still names an ordinary URL after its last path segment', async () => {
    const att: AttachmentInput = { type: 'image', url: 'https://cdn.example.com/pics/cat.png' };
    const deps = makeDeps({ contents: { 'https://cdn.example.com/pics/cat.png': { text: 'png' } } });
    const res = await ingestAttachments([att], CFG, deps);

    expect(res.files[0]?.name).toBe('cat.png');
  });
});

/** The first bytes of each format a model takes, padded to a plausible length. */
const MAGIC = {
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  webp: [0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
};
function picture(magic: number[], length = 64): Uint8Array {
  const out = new Uint8Array(Math.max(length, magic.length));
  out.set(magic);
  return out;
}

describe('sniffImageType', () => {
  it('names the four formats a model takes from their magic numbers', () => {
    expect(sniffImageType(picture(MAGIC.png))).toBe('image/png');
    expect(sniffImageType(picture(MAGIC.jpeg))).toBe('image/jpeg');
    expect(sniffImageType(picture(MAGIC.gif))).toBe('image/gif');
    expect(sniffImageType(picture([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe('image/gif');
    expect(sniffImageType(picture(MAGIC.webp))).toBe('image/webp');
  });

  it('refuses what only resembles one: a RIFF that is audio, a truncated header, HEIC, text', () => {
    expect(sniffImageType(picture([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]))).toBeUndefined();
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeUndefined();
    expect(sniffImageType(picture([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]))).toBeUndefined();
    expect(sniffImageType(bytesOf('PNGDATA'))).toBeUndefined();
    expect(sniffImageType(new Uint8Array())).toBeUndefined();
  });
});

describe('ingestAttachments · pictures the agent is shown', () => {
  const ROOMY: AttachmentIngestConfig = { maxInjectBytes: 100, maxDownloadBytes: 50_000_000 };

  it('returns a picture as bytes AND keeps its path line exactly as before', async () => {
    const att: AttachmentInput = { type: 'image', url: 'p', name: 'pasted-1.png', mime: 'image/png' };
    const bytes = picture(MAGIC.png);
    const res = await ingestAttachments([att], ROOMY, makeDeps({ contents: { p: { bytes } } }));

    expect(res.images).toEqual([{ name: 'pasted-1.png', mimeType: 'image/png', bytes }]);
    // Nothing narrated about the picture being attached: the line says where the file is, as it did.
    expect(res.promptText).toBe('[Attachment pasted-1.png: /cache/pasted-1.png (image/png)]');
    expect(res.heldBack).toEqual([]);
  });

  it('types a picture by its bytes, not by what the platform declared', async () => {
    // A mismatched media_type is a 400 from the API — and the block stays in the session's history.
    const att: AttachmentInput = { type: 'image', url: 'p', name: 'photo.jpg', mime: 'image/jpeg' };
    const res = await ingestAttachments([att], ROOMY, makeDeps({ contents: { p: { bytes: picture(MAGIC.png) } } }));

    expect(res.images[0]?.mimeType).toBe('image/png');
  });

  it('holds back, with a reason, a picture in a format no model takes — it still has its path', async () => {
    const heic = picture([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63]);
    const att: AttachmentInput = { type: 'image', url: 'p', name: 'IMG_0001.heic', mime: 'image/heic' };
    const res = await ingestAttachments([att], ROOMY, makeDeps({ contents: { p: { bytes: heic } } }));

    expect(res.images).toEqual([]);
    expect(res.heldBack).toEqual([{ name: 'IMG_0001.heic', reason: 'not png/jpeg/gif/webp' }]);
    expect(res.promptText).toContain('[Attachment IMG_0001.heic: /cache/IMG_0001.heic');
  });

  it('leaves a picture sent as a document a document', async () => {
    const att: AttachmentInput = { type: 'file', url: 'p', name: 'diagram.png', mime: 'application/octet-stream' };
    const res = await ingestAttachments([att], ROOMY, makeDeps({ contents: { p: { bytes: picture(MAGIC.png) } } }));

    expect(res.images).toEqual([]);
    expect(res.heldBack).toEqual([]);
    expect(res.files).toHaveLength(1);
  });

  it('takes one the element left untyped once its mime says it is a picture (Lark reports it with the bytes)', async () => {
    const att: AttachmentInput = { type: 'file', url: 'p' };
    const deps = makeDeps({ contents: { p: { bytes: picture(MAGIC.jpeg), contentType: 'image/jpeg', name: 'img_v3.jpg' } } });
    const res = await ingestAttachments([att], ROOMY, deps);

    expect(res.images.map((i) => [i.name, i.mimeType])).toEqual([['img_v3.jpg', 'image/jpeg']]);
  });

  it('sends one past the per-picture cap by path only', async () => {
    const atts: AttachmentInput[] = [
      { type: 'image', url: 'fits', name: 'fits.png' },
      { type: 'image', url: 'big', name: 'big.png' },
    ];
    const deps = makeDeps({
      contents: {
        fits: { bytes: picture(MAGIC.png, MAX_PROMPT_IMAGE_BYTES) },
        big: { bytes: picture(MAGIC.png, MAX_PROMPT_IMAGE_BYTES + 1) },
      },
    });
    const res = await ingestAttachments(atts, ROOMY, deps);

    expect(res.images.map((i) => i.name)).toEqual(['fits.png']);
    expect(res.heldBack.map((h) => h.name)).toEqual(['big.png']);
    expect(res.heldBack[0]?.reason).toContain(String(MAX_PROMPT_IMAGE_BYTES));
    expect(res.files.map((f) => f.name)).toEqual(['fits.png', 'big.png']);
  });

  it('stops at the per-message budget, in order: the first pictures go in, the rest by path', async () => {
    const each = 3_500_000;
    const count = Math.floor(MAX_PROMPT_IMAGE_TOTAL_BYTES / each) + 1;
    const atts: AttachmentInput[] = [];
    const contents: Record<string, { bytes: Uint8Array }> = {};
    for (let i = 1; i <= count; i++) {
      atts.push({ type: 'image', url: `s${i}`, name: `shot-${i}.png` });
      contents[`s${i}`] = { bytes: picture(MAGIC.png, each) };
    }
    const res = await ingestAttachments(atts, ROOMY, makeDeps({ contents }));

    expect(res.images.map((i) => i.name)).toEqual(atts.slice(0, count - 1).map((a) => a.name));
    expect(res.heldBack).toEqual([
      { name: `shot-${count}.png`, reason: `the message's pictures pass ${MAX_PROMPT_IMAGE_TOTAL_BYTES} bytes` },
    ]);
  });

  it('keeps attachment order across pictures and other files', async () => {
    const atts: AttachmentInput[] = [
      { type: 'image', url: 'a', name: 'a.webp' },
      { type: 'file', url: 'n', name: 'notes.md', mime: 'text/markdown' },
      { type: 'image', url: 'b', name: 'b.gif' },
    ];
    const deps = makeDeps({
      contents: { a: { bytes: picture(MAGIC.webp) }, n: { text: 'hi' }, b: { bytes: picture(MAGIC.gif) } },
    });
    const res = await ingestAttachments(atts, ROOMY, deps);

    expect(res.images.map((i) => [i.name, i.mimeType])).toEqual([
      ['a.webp', 'image/webp'],
      ['b.gif', 'image/gif'],
    ]);
  });

  it('collects non-image persisted files in promptFiles without duplicating picked images', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const atts: AttachmentInput[] = [
      { type: 'image', url: 'img', name: 'shot.png', mime: 'image/png' },
      { type: 'file', url: 'doc', name: 'report.pdf', mime: 'application/pdf' },
    ];
    const deps = makeDeps({
      contents: { img: { bytes: picture(MAGIC.png) }, doc: { bytes: pdf } },
    });
    const res = await ingestAttachments(atts, ROOMY, deps);

    expect(res.images.map((i) => i.name)).toEqual(['shot.png']);
    expect(res.promptFiles).toEqual([
      { name: 'report.pdf', path: '/cache/report.pdf', mimeType: 'application/pdf', bytes: pdf },
    ]);
  });
});
