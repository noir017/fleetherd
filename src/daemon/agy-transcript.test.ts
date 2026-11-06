import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentDef } from '../config/schema.js';
import type { RemoteHost } from '../remote/host.js';
import { agyContextFromLines, agyTranscriptPath, readAgyContext } from './agy-transcript.js';
import { remoteHosts } from './remote-hosts.js';

/**
 * Lines of agy 1.5.2's `transcript.jsonl` as written (2026-11-06, a running talkcode topic), with the
 * model's text and tool arguments shortened. The token fields and their spelling are verbatim.
 */
const CAPTURED = [
  '{"step_index":99,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-11-06T15:56:27Z","content":"…"}',
  '{"step_index":100,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-06T15:56:28Z","input_tokens":3300,"cache_read_tokens":93336,"output_tokens":161,"tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/w/src/daemon/scheduler.ts"}}]}',
  '{"step_index":101,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-11-06T15:56:34Z","content":"…"}',
  '{"step_index":102,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-06T15:56:34Z","input_tokens":2570,"cache_read_tokens":94591,"output_tokens":124,"tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/w/src/daemon/schedule-store.ts"}}]}',
  '{"step_index":103,"source":"MODEL","type":"GENERIC","status":"DONE","created_at":"2026-11-06T15:56:50Z","content":"…"}',
];

/** The first call of a session: nothing cached yet. */
const FIRST_CALL =
  '{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-11-06T14:56:32Z","input_tokens":19599,"cache_read_tokens":0,"output_tokens":963,"tool_calls":[]}';

describe('agyContextFromLines', () => {
  it('is the last model call’s input plus its cache reads', () => {
    expect(agyContextFromLines(CAPTURED)).toBe(2570 + 94591);
  });

  it('counts a first call that read nothing from the cache', () => {
    expect(agyContextFromLines([FIRST_CALL])).toBe(19599);
  });

  it('skips a line the tail window cut in half, and lines that are not model calls', () => {
    const cut = CAPTURED[3]!.slice(40);
    const error = '{"step_index":94,"source":"SYSTEM","type":"ERROR_MESSAGE","status":"DONE","error":"PLANNER_RESPONSE failed"}';
    expect(agyContextFromLines([CAPTURED[1]!, cut, error])).toBe(3300 + 93336);
  });

  it('reads the lines a host cut down to the fields it was asked for', () => {
    expect(agyContextFromLines(['{"cache_read_tokens":94591,"input_tokens":2570,"type":"PLANNER_RESPONSE"}', ''])).toBe(97161);
  });

  it('finds nothing in a format it no longer understands, rather than guessing', () => {
    expect(agyContextFromLines([])).toBeUndefined();
    expect(agyContextFromLines(['{"type":"PLANNER_RESPONSE","inputTokens":2570}'])).toBeUndefined();
    expect(agyContextFromLines(['{"type":"PLANNER_RESPONSE","input_tokens":"2570"}'])).toBeUndefined();
  });
});

describe('readAgyContext', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const SID = 'ae5d900a-dfce-484f-93ac-ec790b7948f7';

  it('reads the transcript under the agent’s own home', async () => {
    const home = mkdtempSync(join(tmpdir(), 'aa-agy-transcript-'));
    const file = agyTranscriptPath(home, SID);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, CAPTURED.join('\n') + '\n');
    const def = { id: 'agy', harness: 'agy', env: { HOME: home } } as unknown as AgentDef;
    expect(await readAgyContext(def, SID)).toBe(97161);
    expect(await readAgyContext(def, '11111111-2222-3333-4444-555555555555')).toBeUndefined(); // no such session
    expect(await readAgyContext(def, '../../etc')).toBeUndefined(); // never a path
  });

  it('asks a remote host for the model-call lines alone, cut to the token fields', async () => {
    const readTail = vi.fn(async () => '{"cache_read_tokens":94591,"input_tokens":2570,"type":"PLANNER_RESPONSE"}');
    const host = { id: 'pod', isUp: true, conn: { welcome: { home: '/home/user' } }, readTail } as unknown as RemoteHost;
    vi.spyOn(remoteHosts, 'hostFor').mockReturnValue(host);
    const def = { id: 'ag@pod', harness: 'agy', host: 'pod', env: {} } as unknown as AgentDef;
    expect(await readAgyContext(def, SID)).toBe(97161);
    expect(readTail).toHaveBeenCalledWith(
      agyTranscriptPath('/home/user', SID, posix.join),
      expect.any(Number),
      expect.objectContaining({ grep: ['"type":"PLANNER_RESPONSE"'], fields: ['type', 'input_tokens', 'cache_read_tokens'] })
    );
  });

  it('gives up without a word when the host is unreachable or the read fails', async () => {
    const readTail = vi.fn(async () => {
      throw new Error('timed out');
    });
    const down = { id: 'pod', isUp: false, conn: { welcome: { home: '/h' } }, readTail } as unknown as RemoteHost;
    const def = { id: 'ag@pod', harness: 'agy', host: 'pod', env: {} } as unknown as AgentDef;
    vi.spyOn(remoteHosts, 'hostFor').mockReturnValue(down);
    expect(await readAgyContext(def, SID)).toBeUndefined();
    expect(readTail).not.toHaveBeenCalled();
    vi.spyOn(remoteHosts, 'hostFor').mockReturnValue({ ...down, isUp: true, readTail } as unknown as RemoteHost);
    expect(await readAgyContext(def, SID)).toBeUndefined();
  });
});
