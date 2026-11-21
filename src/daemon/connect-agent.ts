/**
 * `connect` agents (config/schema.ts ConnectSchema): an ACP agent that is already running — a
 * service, such as web-agent-driver's daemon — reached over TCP instead of started. Each session
 * dials it once, and the connection stands in for the process: the runtime holds an `AgentChild`
 * either way, so nothing past the spawn has to know which it has.
 *
 * Why not one connection for every session: a session's end is its process ending (`/kill`, End
 * agent, an idle reclaim), and the agent learns a session is over the way a process would — its
 * connection closes. One shared connection would need a `session/close` the gateway never sends.
 *
 * On a remote host fleetherd-remote does the dialling (remote/proc.go connect), so an address only
 * that machine can reach — a container on its private network — works; here it is `net`.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { AgentConnect, AgentDef } from '../config/schema.js';
import type { Welcome } from '../remote/connection.js';
import type { RemoteHost } from '../remote/host.js';
import { expandRemoteHome, type AgentChild } from './agent-common.js';
import { composeInstructions, instructionsDir } from './instructions.js';
import { deliveredTo } from './managed-skills.js';
import { activeSkillFiles, frontmatterFields, SKILL_FILE } from './skills-store.js';

/** `tcp://host:port` → `host:port`, what both sides dial. */
export function connectAddress(connect: AgentConnect): string {
  return connect.url.slice('tcp://'.length);
}

/**
 * A connection as an agent process. Its stdin and stdout are streams of their own, not the socket:
 * closing the ACP connection cancels and aborts the streams it was given, and on the socket itself
 * that is a destroy, which throws away what is still buffered for the agent — the `session/cancel`
 * sent just before an End agent, typically. The socket ends only through `kill`: SIGTERM half-closes
 * it after what was written (the agent then closes its side), anything else drops it.
 */
export class SocketChild extends EventEmitter implements AgentChild {
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(private readonly socket: net.Socket) {
    super();
    this.stdin = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        if (socket.destroyed) cb();
        else socket.write(chunk, () => cb());
      },
      final: (cb) => {
        socket.end();
        cb();
      },
    });
    // Not piped: once the runtime stops reading, the agent's last words still have to drain, or
    // the socket never sees its end and the exit is never reported.
    socket.on('data', (d: Buffer) => {
      if (!this.stdout.destroyed) this.stdout.write(d);
    });
    socket.on('end', () => this.stdout.end());
    let failed = false;
    socket.on('error', (e) => {
      failed = true;
      this.emit('error', e);
    });
    socket.once('close', (hadError) => {
      this.exitCode = hadError || failed ? 1 : 0;
      if (!this.stdout.writableEnded) this.stdout.end();
      this.stderr.end();
      this.emit('exit', this.exitCode, null);
      this.emit('close', this.exitCode, null);
    });
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.exitCode !== null) return false;
    if (signal === 'SIGTERM') this.socket.end();
    else this.socket.destroy();
    return true;
  }
}

/** Dial a connect agent from this machine. A refused or unreachable address arrives as `error` + `exit`. */
export function connectHere(connect: AgentConnect): SocketChild {
  const address = connectAddress(connect);
  const colon = address.lastIndexOf(':');
  const host = address.slice(0, colon).replace(/^\[(.*)\]$/, '$1');
  return new SocketChild(net.connect({ host, port: Number(address.slice(colon + 1)) }));
}

/** Where the agent is: its host's `hosts:` entry, or this machine. */
export interface ConnectPlace {
  host: RemoteHost;
  welcome: Welcome;
}

/**
 * The `_meta` of a connect agent's `initialize`: its `meta` as written, and the gateway's own
 * `fleetherd` entry — the token from `tokenFile`, read on the agent's machine; the machine's name;
 * and the operator's instructions for it. A harness reads those instructions from its own file
 * (daemon/instructions.ts); a connect agent has no file here, so this is that file's contents,
 * nothing added.
 */
export async function connectMeta(def: AgentDef, connect: AgentConnect, place: ConnectPlace | undefined): Promise<Record<string, unknown>> {
  const gateway: Record<string, unknown> = { host: place ? place.host.id : os.hostname() };
  if (connect.tokenFile) gateway['token'] = await readToken(def, connect.tokenFile, place);
  const instructions = connectInstructions(def);
  if (instructions !== undefined) gateway['instructions'] = instructions;
  const skills = connectResidentSkills(def);
  if (skills.length > 0) gateway['skills'] = skills;
  return { ...(connect.meta ?? {}), fleetherd: gateway };
}

/** Resident skills reaching `def` (sorted by name for stable hashing on the agent side). */
function connectResidentSkills(def: AgentDef): Array<{ name: string; description: string }> {
  const out: Array<{ name: string; description: string }> = [];
  for (const skill of activeSkillFiles()) {
    if (!skill.meta.resident || !deliveredTo(skill, def)) continue;
    const raw = skill.files.get(SKILL_FILE)?.toString('utf8') ?? '';
    const description = frontmatterFields(raw).get('description')?.trim();
    if (description) out.push({ name: skill.name, description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The most a token file may be: a token, not a document. */
const TOKEN_MAX_BYTES = 4096;

async function readToken(def: AgentDef, file: string, place: ConnectPlace | undefined): Promise<string> {
  try {
    const raw = place
      ? await place.host.readFile(expandRemoteHome(file, place.welcome.home), TOKEN_MAX_BYTES)
      : fs.readFileSync(file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file);
    const token = raw.toString('utf8').trim();
    if (!token) throw new Error('it is empty');
    return token;
  } catch (e) {
    const where = place ? ` on host "${place.host.id}"` : '';
    throw new Error(`agent "${def.id}": cannot read connect.tokenFile ${file}${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** common.md + `<id>.md`, the id without a pod's `@host`; undefined when there is nothing to give. */
function connectInstructions(def: AgentDef): string | undefined {
  const suffix = def.host ? `@${def.host}` : '';
  const layer = suffix && def.id.endsWith(suffix) ? def.id.slice(0, -suffix.length) : def.id;
  const composed = composeInstructions(instructionsDir(), layer);
  if (composed.kind === 'too-big') {
    console.warn(`[connect] ${def.id}: instructions not sent, ${composed.bytes} bytes is over the limit`);
    return undefined;
  }
  return composed.kind === 'text' ? composed.text : undefined;
}
