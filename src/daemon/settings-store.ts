import { ConfigSchema, findAgent, type Config, type SessionScope } from '../config/schema.js';
import { configDir, configPath, readRawConfigIfExists, saveConfigPatch } from '../config/load.js';
import { readPods, mergePodAgents } from '../config/pods.js';
import { POD_FILE } from './pods.js';
import {
  parseSettingValue,
  readSettingValue,
  settingLocation,
  type SettingApplyResult,
  type SettingRow,
  type SettingsContext,
} from '../core/settings.js';

/**
 * The write half of `/setting`: validate a chosen value, patch config.yaml, and apply it to the
 * daemon that is already running.
 *
 * `core/settings.ts` owns WHAT is editable and what a value means; this owns the file and the live
 * Config object. The split is the same one the model menu draws — the pure module decides, the
 * daemon-side module touches the world.
 *
 * ── The order is fixed, and each step is load-bearing ─────────────────────────
 * 1. parse the value (core), 2. skip a no-op write, 3. **validate a whole candidate config**,
 * 4. resolve the on-disk path, 5. patch the file, 6. apply in memory.
 *
 * Step 3 is the one that earns its keep. `/setting` writes to the file the daemon needs in order to
 * start, from a chat message, possibly from a phone: a value that parses but fails
 * `ConfigSchema.superRefine` (say `routing.default` naming an agent that is not in `agents`) would
 * leave a deployment that runs until it is restarted and then refuses to. Validating a candidate
 * copy first turns that into a refusal in chat.
 *
 * ── Secrets ───────────────────────────────────────────────────────────────────
 * The candidate copy holds `${VAR}`-expanded values, and it never reaches disk: only the single
 * scalar the user chose is patched, through the Document API, which leaves every other line of the
 * file — templates included — byte-identical. See AGENTS.md security invariant #4.
 */

/** What the store needs from the running daemon to make a change take effect now. */
export interface SettingsLiveHooks {
  /**
   * `session.idleTimeoutMs` changed: re-arm the idle sweeper.
   *
   * A hook rather than a field write because the sweeper's TIMER, not just the number, has to
   * change — it is not armed at all when the value starts at 0, and it keeps ticking after the
   * value becomes 0. See ConversationRegistry.setIdleTimeout.
   */
  onIdleTimeout(ms: number): void;

  /**
   * `delegation.confirm` changed tier: Delegation's in-memory record of agents already confirmed
   * no longer applies. A hook because a change away and back is invisible to a read of the config
   * at the next `task-new` — the value it would compare against is the same again.
   */
  onDelegationChanged(): void;
}

export class SettingsStore {
  constructor(
    /** The LIVE runtime config — mutated in place for settings that take effect immediately. */
    private readonly config: Config,
    private readonly live: SettingsLiveHooks
  ) {}

  /**
   * Set one setting. Never throws: every failure becomes a `SettingApplyResult` the caller turns
   * into a sentence, because one of the two callers is a button click with nobody to re-prompt.
   */
  apply(
    row: SettingRow,
    raw: string,
    ctx: SettingsContext,
    /** Whether the asking conversation has a `/model` override shadowing what is being written. */
    overridden = false
  ): SettingApplyResult {
    const parsed = parseSettingValue(row, raw, this.config, ctx);
    if (parsed.kind === 'invalid') return { kind: 'invalid', row, reason: parsed.reason };

    if (parsed.value === readSettingValue(row, this.config)) return { kind: 'unchanged', row };

    // Validate a candidate config before writing anything (see the header).
    const candidate = candidateOf(this.config);
    applyToConfig(candidate, row, parsed.value);
    const check = ConfigSchema.safeParse(candidate);
    if (!check.success) {
      const first = check.error.issues[0];
      const where = first?.path.join('.') || '(root)';
      return {
        kind: 'invalid',
        row,
        reason: `That would make config.yaml invalid (${where}: ${first?.message ?? 'unknown'}), so nothing was written.`,
      };
    }

    // The next start reads the FILE, which may already disagree with the running config: an agent
    // deleted by hand (no `/reload` yet), or a pod that stopped declaring one when pods.json was
    // rewritten by a reload whose second read failed. The candidate check above only sees the
    // running config, so writing the reviewer it still knows would leave a config.yaml the next
    // start refuses (`review.agent references a non-existent agent id`). See writeTarget.
    const target = this.writeTarget(row, parsed.value);
    if ('reason' in target) return { kind: 'failed', row, reason: target.reason };
    const path = target.path;

    try {
      saveConfigPatch([emptied(path, parsed.value, this.config) ?? { path, value: parsed.value }]);
    } catch (e) {
      return { kind: 'failed', row, reason: e instanceof Error ? e.message : String(e) };
    }

    // A restart-only setting is deliberately NOT applied in memory: for session.scope, applying it
    // live would silently re-identify every existing conversation (the key function changes, so the
    // next message in a topic lands in a brand-new conversation with no context) while the old
    // agent children sit resident until reclaim. The file is the durable answer; the ack says so.
    if (row.effect !== 'restart') {
      applyToConfig(this.config, row, parsed.value);
      if (row.id === 'idle') this.live.onIdleTimeout(Number(parsed.value));
      if (row.id === 'delegation') this.live.onDelegationChanged();
    }

    console.log(
      `[setting] ${row.label} → ${parsed.display} (${row.effect}) written to ${configPath()}`
    );
    return {
      kind: 'saved',
      row,
      display: parsed.display,
      ...(parsed.note ? { note: parsed.note } : {}),
      ...(overridden ? { overridden } : {}),
    };
  }

  /**
   * The path to patch, or the sentence explaining why there is none. A model row's path can be
   * missing because the file no longer has that agent; `review.agent` asks the same question of the
   * file's and the pods' agents (see staleReviewAgent) before it is used.
   */
  private writeTarget(
    row: SettingRow,
    value: string | number | boolean | undefined
  ): { path: Array<string | number> } | { reason: string } {
    const stale = this.staleReviewAgent(row, value);
    if (stale) return { reason: stale };
    const path = this.diskPath(row);
    if (path) return { path };
    // A pod's agent is written to `podModels` (settingLocation) — reaching here means its row was
    // built without knowing it is a pod's (pods.json unreadable), so say where it lives instead.
    const pod = podOf(row.target);
    return {
      reason: pod
        ? `${row.target} is declared on ${pod}, in ~/${POD_FILE} there — change it in that file and /reload; \`/model\` changes it for this conversation only`
        : `no \`agents:\` entry with id "${row.target}" in ${configPath()} — the file has changed since the daemon started; edit it directly`,
    };
  }

  /**
   * The path to patch in the FILE.
   *
   * A per-agent setting is the reason this is not just `settingLocation().path`: `agents:` is a
   * sequence, so the patch needs an index, and the index has to come from the file as it is right
   * now. Using the runtime array's index would write to the wrong agent if anyone reordered
   * `agents:` by hand since startup — a silent mis-write, which is the worst outcome available
   * here. Returns null when the file has no entry with that id, and the caller says so.
   */
  private diskPath(row: SettingRow): Array<string | number> | null {
    const location = settingLocation(row);
    if (location.kind === 'path') return location.path;
    const raw = readRawConfigIfExists();
    const agents = raw?.['agents'];
    if (!Array.isArray(agents)) return null;
    const index = agents.findIndex(
      (a) => typeof a === 'object' && a !== null && (a as { id?: unknown }).id === location.agentId
    );
    return index < 0 ? null : ['agents', index, location.key];
  }

  /**
   * Why `review.agent` cannot be written, when the file no longer backs the running config — the
   * same guard diskPath gives a model row, asked of config.yaml plus every host's pod.yaml.
   *
   * `review.agent` is a plain path (`review.agent`), so it never went through diskPath: the running
   * config was the only thing checked, and it can be ahead of the file. The rewrite of pods.json
   * before a reload's second read is the case that makes this more than a hand-edit: pods.json is
   * already the new one, the running config still holds the agent, and a write here would name an
   * agent no host declares any more. Being agy is checked from the same merged view, because the
   * schema's rule is about the agent the file defines, not the one the daemon remembers.
   */
  private staleReviewAgent(
    row: SettingRow,
    value: string | number | boolean | undefined
  ): string | undefined {
    if (row.id !== 'review.agent' || typeof value !== 'string') return undefined;
    const merged = mergePodAgents(readRawConfigIfExists() ?? {}, readPods(configDir())).raw;
    const agents = Array.isArray(merged['agents']) ? (merged['agents'] as unknown[]) : [];
    const def = agents.find(
      (a) => typeof a === 'object' && a !== null && (a as { id?: unknown }).id === value
    ) as { harness?: unknown } | undefined;
    if (!def) {
      return `no \`agents:\` entry with id "${value}" in ${configPath()} or any host's pod.yaml — the files have changed since the daemon started; /reload, then pick again`;
    }
    if (def.harness !== 'agy') {
      return `\`${value}\` is a ${String(def.harness)} agent in the file; a review runs \`agy -p\` with every tool denied, so it must be an agy agent`;
    }
    return undefined;
  }
}

/**
 * Write a parsed value onto a config object.
 *
 * Exhaustive on purpose: a new setting cannot be added without stating where it lands and, because
 * the same function is used for the candidate and for the live object, without its live-apply
 * behavior being considered at the same time.
 */
function applyToConfig(cfg: Config, row: SettingRow, value: string | number | boolean | undefined): void {
  switch (row.id) {
    case 'agent':
      cfg.routing.default = String(value);
      return;
    case 'model':
      applyModel(cfg, row, value);
      return;
    case 'delegation':
      // Live: Delegation.propose reads this per `task-new`, so the very next proposal follows it —
      // including one an agent is about to make in the turn that asked for the change. `first` is
      // the middle tier, so it is written as its own word rather than coerced to a boolean.
      cfg.delegation.confirm = value === 'first' ? 'first' : Boolean(value);
      return;
    case 'idle':
      cfg.session.idleTimeoutMs = Number(value);
      return;
    case 'scope':
      // Narrowed by parseSettingValue (only the four SessionScope literals reach here) and
      // re-checked by the ConfigSchema pass in apply() before anything is written.
      cfg.session.scope = value as SessionScope;
      return;
    case 'stream':
      // Live: TurnRunner resolves the delivery mode per turn from this object, so the next reply
      // uses the new setting — no restart, and a turn already in flight finishes as it started.
      cfg.stream.enabled = Boolean(value);
      return;
    case 'voice':
      // Live: daemon/voice.ts reads `confirm` when each transcript is ready, so the very next voice
      // message follows it — including one already being transcribed when the switch was flipped.
      // The row exists only where `voice` does (settingsRows), so the block is there to write into.
      if (cfg.voice) cfg.voice.confirm = Boolean(value);
      return;
    case 'cleanup':
      // Live, for the same reason: read when each voice note's transcription request is built.
      if (cfg.voice) cfg.voice.cleanup = Boolean(value);
      return;
    case 'review.agent':
      // Live: ReviewService.reviewer() re-reads `review.agent` at the start of every sweep (every
      // minute), and the sweep in flight re-reads it before each candidate — so this lands on the
      // next pass, not on a restart. Off deletes the whole block because the schema requires an
      // agent whenever `review:` exists (the patch's `emptied` does the same to the file).
      if (value === undefined) delete cfg.review;
      else cfg.review = { ...cfg.review, agent: String(value) };
      return;
    case 'review.model':
      // Live for the same reason: runOne reads `review.model` per review, so a review that starts
      // after this write uses it. parseSettingValue refuses this when no reviewer is set, so the
      // block exists; an undefined value deletes only the optional key, keeping the reviewer.
      if (!cfg.review) return;
      if (value === undefined) delete cfg.review.model;
      else cfg.review = { ...cfg.review, model: String(value) };
      return;
    default: {
      const _exhaustive: never = row.id;
      throw new Error(`no config location for setting ${String(_exhaustive)}`);
    }
  }
}

/**
 * A copy of the config to validate a change against. Shallow, but covering every branch
 * applyToConfig can touch, so the live config is untouched if validation fails — and `platforms`
 * is shared by reference deliberately: nothing here writes to it.
 */
function candidateOf(config: Config): Config {
  return {
    ...config,
    routing: { ...config.routing },
    session: { ...config.session },
    delegation: { ...config.delegation },
    agents: config.agents.map((a) => ({ ...a })),
    ...(config.review ? { review: { ...config.review } } : {}),
    ...(config.podModels ? { podModels: { ...config.podModels } } : {}),
  };
}

/**
 * A model row's write. The agent DEF is mutated in place, not replaced: findAgent returns the live
 * array element, which is the very object each AgentSession captured at construction — so the next
 * spawn of an already-running conversation reads the new model (agent-acp applyModelPreference /
 * agent-agy's --model=) without anything having to re-resolve it.
 */
function applyModel(cfg: Config, row: SettingRow, value: string | number | boolean | undefined): void {
  const def = findAgent(cfg, row.target ?? '');
  if (row.pod && row.target) {
    // A pod's agent: the gateway's own entry, and the merged model readConfig would compute from it
    // (config/pods.ts mergePodAgents) — cleared, that is the pod's again.
    const next = { ...(cfg.podModels ?? {}) };
    if (value === undefined) delete next[row.target];
    else next[row.target] = String(value);
    if (Object.keys(next).length > 0) cfg.podModels = next;
    else delete cfg.podModels;
    if (def) def.model = value === undefined ? row.pod.model : String(value);
    return;
  }
  if (def) def.model = value === undefined ? undefined : String(value);
}

/**
 * A patch that has to replace the row's own path. Two cases: clearing the last `podModels` entry
 * writes the whole map rather than its one key, so a file is not left holding `podModels: {}`; and
 * turning auto review off deletes `review:` whole, because `review.agent` is required whenever the
 * block exists and a file left with a lone `review.model` would not load. Undefined for every
 * other write.
 */
function emptied(
  path: Array<string | number>,
  value: unknown,
  cfg: Config
): { path: Array<string | number>; value: undefined } | undefined {
  if (value !== undefined) return undefined;
  if (path.length === 2 && path[0] === 'review' && path[1] === 'agent') {
    return { path: ['review'], value: undefined };
  }
  if (path[0] !== 'podModels' || path.length !== 2) return undefined;
  const left = Object.keys(cfg.podModels ?? {}).filter((k) => k !== path[1]);
  return left.length === 0 ? { path: ['podModels'], value: undefined } : undefined;
}

/** The host whose pod declared `agentId` (`<id>@<host>`, and in pods.json), or undefined. */
function podOf(agentId: string | undefined): string | undefined {
  const at = agentId?.lastIndexOf('@') ?? -1;
  if (!agentId || at < 1) return undefined;
  const host = agentId.slice(at + 1);
  const own = agentId.slice(0, at);
  const agents = readPods(configDir())[host]?.agents ?? [];
  return agents.some((a) => a && typeof a === 'object' && (a as { id?: unknown }).id === own) ? host : undefined;
}
