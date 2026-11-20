import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeAgentImage, MAX_AGENT_IMAGE_BYTES, sendBytesAsFile } from './agent-files.js';
import type { ConversationAddress } from '../core/conversation.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);
const b64 = (bytes: Buffer): string => bytes.toString('base64');
const address: ConversationAddress = { channel: 'c1', kind: 'direct' } as ConversationAddress;

describe('decodeAgentImage', () => {
  it('decodes a picture and names it by its number and its sniffed type', () => {
    const p = decodeAgentImage({ data: b64(PNG), mimeType: 'image/png' }, 3);
    expect(p).toEqual({ bytes: PNG, mimeType: 'image/png', name: 'image-3.png' });
  });

  it("takes the type from the bytes, never the agent's claim", () => {
    const p = decodeAgentImage({ data: b64(JPEG), mimeType: 'image/png', name: 'photo.png' }, 1);
    expect(p).toMatchObject({ mimeType: 'image/jpeg', name: 'photo.jpg' });
  });

  it('refuses what is not a png, jpeg, gif or webp', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(decodeAgentImage({ data: b64(svg), mimeType: 'image/svg+xml' }, 1)).toEqual({
      refused: 'not png/jpeg/gif/webp (said "image/svg+xml")',
    });
    expect(decodeAgentImage({ data: '!!!', mimeType: 'image/png' }, 1)).toHaveProperty('refused');
  });

  it('refuses a picture over the cap before decoding it', () => {
    const data = 'A'.repeat(Math.ceil(((MAX_AGENT_IMAGE_BYTES + 3) * 4) / 3));
    const p = decodeAgentImage({ data, mimeType: 'image/png' }, 1);
    expect(p).toHaveProperty('refused');
    expect((p as { refused: string }).refused).toMatch(/^about \d+ bytes, over /);
  });

  it('takes a data URL as the base64 it carries', () => {
    const p = decodeAgentImage({ data: `data:image/png;base64,${b64(PNG)}`, mimeType: 'image/png' }, 1);
    expect(p).toMatchObject({ mimeType: 'image/png', bytes: PNG });
  });

  it('makes the name the agent gave fit to be a file name, keeping letters of any script', () => {
    const name = (n: string): string | undefined => (decodeAgentImage({ data: b64(PNG), mimeType: 'image/png', name: n }, 7) as { name?: string }).name;
    expect(name('图表.png')).toBe('图表.png');
    expect(name('/tmp/out/q3 sales.jpeg')).toBe('q3 sales.png');
    expect(name('..\\..\\evil')).toBe('evil.png');
    expect(name('a<b>:c?.png')).toBe('a_b_c_.png');
    expect(name('.hidden.png')).toBe('hidden.png');
    expect(name('..')).toBe('image-7.png');
    expect(name('x'.repeat(200))).toBe(`${'x'.repeat(80)}.png`);
  });
});

describe('sendBytesAsFile', () => {
  it('sends a private temporary file under the given name, and removes it once sent', async () => {
    let seen: { path: string; name?: string; bytes: Buffer; mode: number } | undefined;
    const ref = await sendBytesAsFile(
      {
        sendFile: async (_a, file) => {
          seen = { path: file.path, name: file.name, bytes: fs.readFileSync(file.path), mode: fs.statSync(file.path).mode & 0o777 };
          return { address, messageId: 'f1' };
        },
      },
      address,
      PNG,
      { fileName: 'chart.png' }
    );
    expect(ref.messageId).toBe('f1');
    expect(seen).toMatchObject({ name: 'chart.png', bytes: PNG, mode: 0o600 });
    expect(seen!.path.endsWith('/chart.png')).toBe(true);
    expect(fs.existsSync(seen!.path)).toBe(false);
  });

  it('removes the file when the send fails too', async () => {
    let sent = '';
    await expect(
      sendBytesAsFile(
        {
          sendFile: async (_a, file) => {
            sent = file.path;
            throw new Error('413 Request Entity Too Large');
          },
        },
        address,
        PNG,
        { fileName: 'report.bin', name: 'report.pdf', caption: 'Q3' }
      )
    ).rejects.toThrow('413');
    expect(sent).not.toBe('');
    expect(fs.existsSync(sent)).toBe(false);
  });
});
