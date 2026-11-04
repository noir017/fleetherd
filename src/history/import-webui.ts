import fs from 'node:fs';
import path from 'node:path';
import type { HistoryKind, HistoryMessage, HistorySessionMeta, HistoryStore } from './store.js';

/**
 * Fold the web UI's kept transcripts into the conversation library, once.
 *
 * The web UI has kept every topic's ring on disk since 2.13.0
 * (`webui-transcripts-<instance>/<topic>.json`, see platform/webui/README.md), so those
 * conversations predate the library and are the only history that can be recovered — the chat
 * platforms offer no way to read a bot's past messages back. A transcript file is a snapshot of
 * a ring that is rewritten every few seconds while a topic is active, so "import" means "take
 * this file once": the live recorder owns everything after the upgrade. `imported` in the store
 * is what makes a second start a no-op.
 *
 * A malformed file is skipped with a log line, never thrown: one bad transcript must not keep
 * the gateway from starting.
 */

export interface WebuiImportSummary {
  /** Transcript files seen. */
  files: number;
  imported: number;
  /** Files already imported on an earlier start. */
  skipped: number;
  failed: number;
  messages: number;
}

interface KeptMessage {
  msg?: { own?: unknown; at?: unknown; kind?: unknown };
  text?: unknown;
}

interface TopicRecord {
  title?: unknown;
  scheduled?: unknown;
  parent?: unknown;
}

/** Import every `webui-transcripts-*` directory under `dir`. */
export function importWebuiTranscripts(
  dir: string,
  store: HistoryStore,
  log: (message: string) => void = (m) => console.warn(m)
): WebuiImportSummary {
  const summary: WebuiImportSummary = { files: 0, imported: 0, skipped: 0, failed: 0, messages: 0 };
  if (!store.available) return summary;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return summary;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('webui-transcripts-')) continue;
    const instance = entry.name.slice('webui-transcripts-'.length);
    if (!instance) continue;
    const topics = readTopics(path.join(dir, `webui-topics-${instance}.json`), log);
    const transcriptDir = path.join(dir, entry.name);
    let names: string[];
    try {
      names = fs.readdirSync(transcriptDir);
    } catch (e) {
      log(`[history] could not read ${transcriptDir}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    for (const name of names) {
      const topicId = /^([0-9a-f]{8})\.json$/.exec(name)?.[1];
      if (!topicId) continue;
      summary.files++;
      const result = importOne(entry.name, transcriptDir, name, topicId, instance, topics, store, log);
      if (result.status === 'imported') {
        summary.imported++;
        summary.messages += result.messages;
      } else if (result.status === 'failed') {
        summary.failed++;
      } else {
        summary.skipped++;
      }
    }
  }
  return summary;
}

/** One transcript file: parse, map, import. Its own function so the scan above stays readable. */
function importOne(
  sourceDir: string,
  transcriptDir: string,
  name: string,
  topicId: string,
  instance: string,
  topics: Map<string, TopicRecord>,
  store: HistoryStore,
  log: (message: string) => void
): { status: 'imported'; messages: number } | { status: 'skipped' | 'failed' } {
  const source = `${sourceDir}/${name}`;
  if (store.imported(source)) return { status: 'skipped' };
  try {
    const kept = readTranscript(path.join(transcriptDir, name));
    const topic = topics.get(topicId);
    const kind = kindOf(topic);
    const messages = kept.flatMap((k) => toMessages(k, kind));
    if (messages.length === 0) return { status: 'skipped' };
    const first = messages[0]!;
    const last = messages[messages.length - 1]!;
    const meta: HistorySessionMeta = {
      key: `${instance}#main#${topicId}`,
      platform: instance,
      title: typeof topic?.title === 'string' ? topic.title : '',
      kind,
      at: first.ts,
      lastAt: last.ts,
    };
    return store.importSession(source, meta, messages) === 'imported'
      ? { status: 'imported', messages: messages.length }
      : { status: 'skipped' };
  } catch (e) {
    log(`[history] could not import ${source}: ${e instanceof Error ? e.message : e}`);
    return { status: 'failed' };
  }
}

/** The topic file is this module's only source of titles, and a missing one is normal. */
function readTopics(file: string, log: (message: string) => void): Map<string, TopicRecord> {
  const out = new Map<string, TopicRecord>();
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return out;
  }
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === 'object') out.set(id, value as TopicRecord);
  }
  if (out.size === 0) log(`[history] ${file} named no topics; imported conversations keep their ids as titles`);
  return out;
}

/** One kept ring, validated field by field: the file is the daemon's own, but it is still input. */
function readTranscript(file: string): KeptMessage[] {
  const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is KeptMessage => {
    if (!v || typeof v !== 'object') return false;
    const k = v as KeptMessage;
    return !!k.msg && typeof k.msg.at === 'number' && typeof k.text === 'string';
  });
}

function kindOf(topic: TopicRecord | undefined): HistoryKind {
  if (topic?.scheduled === true) return 'schedule';
  if (typeof topic?.parent === 'string' && topic.parent) return 'subagent';
  return 'normal';
}

/**
 * One kept message into library rows. A tool bubble's `text` is one rendered line per call
 * (`🔧 Bash: "git status"`), so it becomes one row per line, with the decoration removed —
 * the library's tool rows read `Bash: git status`, the same as the live recorder writes them.
 */
function toMessages(kept: KeptMessage, kind: HistoryKind): HistoryMessage[] {
  const text = typeof kept.text === 'string' ? kept.text.trim() : '';
  if (!text) return [];
  const ts = kept.msg?.at as number;
  if (kept.msg?.kind === 'tools') {
    return text
      .split('\n')
      .map((line) => toolLineFromRendered(line))
      .filter((line) => line.length > 0)
      .map((line) => ({ ts, role: 'tool' as const, kind, text: line }));
  }
  return [{ ts, role: kept.msg?.own === true ? 'user' : 'agent', kind, text }];
}

/** `🔧 Bash: "git status"` → `Bash: git status`; an unparsable line is kept as it is. */
export function toolLineFromRendered(line: string): string {
  const flat = line.replace(/\s+/g, ' ').trim();
  // The renderer's prefixes vary: an emoji, and for a subagent `↳ cc · 🔧 Bash: "…"`. Anything
  // before the tool name is decoration; the name is the first `Word:` in the line.
  const m = /^(?:.*?)([A-Za-z][\w.-]*):\s*"?(.*?)"?$/.exec(flat);
  if (!m?.[1]) return flat;
  const detail = m[2]?.trim() ?? '';
  return detail ? `${m[1]}: ${detail}` : m[1];
}
