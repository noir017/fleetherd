import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sniffImageType, type PromptImageType } from '../core/attachment-ingest.js';
import type { ConversationAddress } from '../core/conversation.js';
import type { PlatformAdapter } from '../platform/adapter.js';
import type { MessageRef } from '../types.js';
import type { AgentImage } from './agent.js';

/**
 * What an agent puts into the chat as a file: a picture in its reply (AgentStreamHandlers.onImage),
 * or a file it names with `send-file` from a remote host. Both arrive as bytes, and every platform's
 * `sendFile` takes a path.
 */

/**
 * Largest picture from an agent's reply that is sent on. A chart or a screenshot is well under a
 * megabyte; past this the agent is moving a file, and `send-file` is the way to do that. The cap is
 * checked on the base64 length before anything is decoded, so an oversized block costs no second
 * copy of itself.
 */
export const MAX_AGENT_IMAGE_BYTES = 15 * 1024 * 1024;

const EXTENSION: Record<PromptImageType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/** A picture from the agent, checked and ready to send. */
export interface AgentPicture {
  bytes: Buffer;
  /** Read off the bytes; the agent's own `mimeType` is never used. */
  mimeType: PromptImageType;
  /** The file name it is sent under, its extension the sniffed type's. */
  name: string;
}

/**
 * Decode and check one picture from an agent's reply, or say why it is not sent.
 *
 * The type is sniffed from the bytes, as an inbound picture's is (core `sniffImageType`): the
 * `mimeType` on the wire is the agent's claim, and a platform told a PNG is a JPEG — or handed an
 * SVG, or a block that is not an image at all — renders a broken picture at best. Only the four
 * types a model API takes get through, which are also the four every chat platform shows inline.
 *
 * `seq` numbers the pictures of one reply, for the name of one the agent did not name.
 */
export function decodeAgentImage(image: AgentImage, seq: number): AgentPicture | { refused: string } {
  // ACP says plain base64, but a data URL is what a tool result often hands an agent to pass on.
  const data = image.data.replace(/^data:[^,]*,/, '');
  // base64 carries 3 bytes in 4 characters; checked before decoding so the cap bounds memory too.
  const estimate = Math.floor((data.length * 3) / 4);
  if (estimate > MAX_AGENT_IMAGE_BYTES + 2) return { refused: `about ${estimate} bytes, over ${MAX_AGENT_IMAGE_BYTES}` };
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0) return { refused: 'no data' };
  if (bytes.length > MAX_AGENT_IMAGE_BYTES) return { refused: `${bytes.length} bytes, over ${MAX_AGENT_IMAGE_BYTES}` };
  const mimeType = sniffImageType(bytes);
  if (!mimeType) return { refused: `not png/jpeg/gif/webp (said ${JSON.stringify(image.mimeType)})` };
  const stem = (image.name && safeStem(image.name)) || `image-${seq}`;
  return { bytes, mimeType, name: `${stem}.${EXTENSION[mimeType]}` };
}

/**
 * A name the agent gave, made fit to be a file name here: its last path segment, without its
 * extension (the sniffed type supplies one), with separators and control characters replaced and no
 * leading dot. Empty when nothing usable is left. Letters of any script are kept — a picture called
 * `图表.png` keeps its name.
 */
function safeStem(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  return stem.replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 80);
}

/**
 * Send bytes as a file: write them to a private temporary file, send that, and remove it.
 *
 * Removing it as soon as `sendFile` returns is safe because every adapter is done with the path by
 * then: the chat platforms upload inside the call, and the web UI — which serves a file when someone
 * clicks, possibly days later — copies it before it resolves (webui/room.ts publishCopy).
 *
 * `fileName` is the temporary file's name; `name`, when given, is what the platform shows instead.
 */
export async function sendBytesAsFile(
  platform: Pick<PlatformAdapter, 'sendFile'>,
  address: ConversationAddress,
  bytes: Uint8Array,
  file: { fileName: string; name?: string; caption?: string }
): Promise<MessageRef> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fleetherd-file-'));
  try {
    const local = path.join(dir, file.fileName);
    await fs.promises.writeFile(local, bytes, { mode: 0o600 });
    return await platform.sendFile(address, { path: local, name: file.name ?? file.fileName, caption: file.caption });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
