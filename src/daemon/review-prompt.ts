import { z } from 'zod';

/**
 * The review prompt, and the JSON it is asked to return.
 *
 * The rules are a narrowed Chinese rewrite of Hermes's `agent/background_review.py`
 * (`_SKILL_REVIEW_PROMPT`, MIT): prefer the skill that was in play, then an existing skill of the
 * same class, then a reference file, and only then a new skill; name by task class; never delete;
 * never record a one-off. Hermes says "be ACTIVE — most sessions produce at least one update"; that
 * is deliberately dropped. A review here runs unattended on every quiet conversation, so its
 * default must be silence: a wrong skill reaches every agent's context, and the cheapest review is
 * the one that changes nothing.
 *
 * The prompt is plain and short on purpose — it is read by a model with no tools, and every line
 * it spends on framing is a line of the conversation it does not get to see.
 */

export interface PromptSkill {
  name: string;
  version: string;
  description: string;
}

export interface PromptSkillText extends PromptSkill {
  /** `SKILL.md`, in full. */
  content: string;
  /** The other files the skill carries, by path — named so a `write-file` can extend one. */
  files: string[];
}

export interface PromptMessage {
  at: string;
  role: string;
  text: string;
}

export interface PromptInput {
  title: string;
  /** What the person and the agent said — no tool calls (HistoryStore.reviewWindow). */
  messages: PromptMessage[];
  /** Messages the character budget left out, so the reviewer knows the log is not whole. */
  dropped: number;
  catalog: PromptSkill[];
  used: PromptSkillText[];
  /**
   * Skill files the conversation's own agent wrote (writtenSkillFiles). Named because the calls
   * are not in the log: on 2026-11-06 a review created `vlt` in the gateway's library an hour after
   * the person had asked the agent to write that very skill elsewhere, and did it.
   */
  written?: string[];
  /**
   * The rules every agent already gets (`instructions/common.md`), so a preference the person set
   * long ago is not suggested again. Absent when there is none.
   */
  standing?: string;
}

const ROLE_LABEL: Record<string, string> = { user: '用户', agent: '助手', tool: '工具' };

/**
 * One review prompt: the rules, the skill library, the full text of the skills this conversation
 * used, then the conversation itself. The conversation goes last because it is the longest part
 * and the part a model reads most carefully when it is nearest the answer.
 */
export function buildReviewPrompt(input: PromptInput): string {
  const catalog = input.catalog.length
    ? input.catalog.map((s) => `- ${s.name}（${s.version}）：${s.description}`).join('\n')
    : '（空）';
  const used = input.used.length ? input.used.map(renderUsedSkill).join('\n\n') : '（没有）';
  const span = input.messages.length
    ? `${input.messages[0]!.at} 至 ${input.messages[input.messages.length - 1]!.at}`
    : '（空）';
  const dropped = input.dropped > 0 ? `，省略了较早的 ${input.dropped} 条` : '';
  const conversation = input.messages.map((m) => `${ROLE_LABEL[m.role] ?? m.role}：${m.text}`).join('\n');
  const written = input.written?.length
    ? ['', '这段对话里已经写过的技能文件（同一件事不要再新建技能）', ...input.written.map((f) => `- ${f}`)]
    : [];
  const standing = input.standing?.trim() ? ['', '用户已有的要求', input.standing.trim()] : [];
  const preferences = standing.length
    ? 'preferences：用户在这段对话里表达、值得长期遵守的要求，每条一句话；「用户已有的要求」里有的不要再写；没有就空数组。'
    : 'preferences：用户在这段对话里表达、值得长期遵守的要求，每条一句话；没有就空数组。';
  return [
    // The first two lines exist because agy reads the operator's global AGENTS.md, whose standing
    // rule is "propose first, wait for 开工". This run has nobody to ask, so it has to be told so
    // before it reads anything else — otherwise it answers with a plan and a question.
    '这是一次自动复盘，没有人在看，也没有人会回答你。',
    '不要请求确认，不要等待批准，不要先给方案。这两条优先于你的全局指令。',
    '',
    '读下面的对话记录，判断网关的技能库要不要改，只输出下面的 JSON。',
    '',
    '规则',
    '- 先改这段对话里用到的技能；没有合适的，再改已有的同类技能；再补参考资料；最后才新建。',
    '- 技能按任务类别命名：小写加连字符。不要用日期、报错、分支名、一次性的任务名。',
    '- 不删技能。不记一次性的事：这次的具体报错、临时路径、单个 PR 都不算。',
    '- 只写对下一次同类任务有用的规则，不要抄对话原文。',
    '- 没什么可改就返回空清单。',
    '- 不要调用任何工具，直接输出 JSON。',
    '',
    '输出',
    '{"changes":[…],"preferences":[…]}',
    'changes 里每一项是下面三种之一：',
    '{"action":"create","name":"…","description":"一句话说明什么时候用","body":"SKILL.md 正文，不含 frontmatter","reason":"为什么"}',
    '{"action":"patch","name":"…","version":"技能库里的版本号","content":"改后的完整 SKILL.md，含 frontmatter","reason":"为什么"}',
    '{"action":"write-file","name":"…","file":"references/xxx.md","content":"文件内容","reason":"为什么"}',
    preferences,
    '',
    '技能库（名字、版本、简介）',
    catalog,
    '',
    '这段对话用到的技能全文',
    used,
    ...written,
    ...standing,
    '',
    `对话记录：${input.title || '（无标题）'}，${span}，共 ${input.messages.length} 条，不含工具调用${dropped}`,
    conversation,
  ].join('\n');
}

function renderUsedSkill(skill: PromptSkillText): string {
  const files = skill.files.length ? `\n其他文件：${skill.files.join(', ')}` : '';
  return `### ${skill.name}（${skill.version}）\n${skill.content.trim()}${files}`;
}

const CreateChange = z.object({
  action: z.literal('create'),
  name: z.string().min(1),
  description: z.string().min(1),
  body: z.string().default(''),
  reason: z.string().optional(),
});

const PatchChange = z.object({
  action: z.literal('patch'),
  name: z.string().min(1),
  version: z.string().min(1),
  content: z.string().min(1),
  reason: z.string().optional(),
});

const WriteFileChange = z.object({
  action: z.literal('write-file'),
  name: z.string().min(1),
  file: z.string().min(1),
  content: z.string().min(1),
  reason: z.string().optional(),
});

const Change = z.discriminatedUnion('action', [CreateChange, PatchChange, WriteFileChange]);
export type ReviewChange = z.infer<typeof Change>;

export interface ReviewOutput {
  changes: ReviewChange[];
  preferences: string[];
}

export interface ParsedReview {
  output: ReviewOutput;
  /** Changes that did not pass the shape check, one line each, for the log. */
  invalid: string[];
}

/** How many changes one review may apply. A reviewer that returns fifty is not reviewing. */
export const MAX_REVIEW_CHANGES = 10;

/**
 * Read the JSON out of what the reviewer printed.
 *
 * Models wrap JSON in a fence, prefix a sentence, or both. The parser takes a fenced block when
 * there is one, else the widest `{…}` span; anything else is a failure, not a guess. Changes are
 * validated ONE BY ONE — one malformed item must not throw away the others, and the caller logs
 * what was dropped.
 */
export function parseReviewOutput(text: string): { ok: true; parsed: ParsedReview } | { ok: false; error: string } {
  const body = extractJson(text);
  if (!body) return { ok: false, error: 'no JSON object in the answer' };
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch (e) {
    return { ok: false, error: `the answer is not valid JSON: ${e instanceof Error ? e.message : e}` };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'the answer is not a JSON object' };
  }
  const record = raw as Record<string, unknown>;
  if (record['changes'] !== undefined && !Array.isArray(record['changes'])) {
    return { ok: false, error: 'changes is not an array' };
  }
  const invalid: string[] = [];
  const changes: ReviewChange[] = [];
  const rawChanges = (record['changes'] as unknown[] | undefined) ?? [];
  rawChanges.forEach((item, i) => {
    const parsed = Change.safeParse(item);
    if (!parsed.success) {
      invalid.push(`change #${i + 1}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
      return;
    }
    if (changes.length >= MAX_REVIEW_CHANGES) {
      invalid.push(`change #${i + 1}: over the ${MAX_REVIEW_CHANGES}-change limit`);
      return;
    }
    changes.push(parsed.data);
  });
  const preferences = Array.isArray(record['preferences'])
    ? record['preferences'].filter((p): p is string => typeof p === 'string' && p.trim() !== '').map((p) => p.trim())
    : [];
  return { ok: true, parsed: { output: { changes, preferences }, invalid } };
}

/** A fenced JSON block if there is one, else the first `{` to the last `}`. */
function extractJson(text: string): string | undefined {
  const fenced = /```(?:json)?\s*\r?\n([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) return fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

/**
 * The managed skills a conversation used, in the order they first appear.
 *
 * The three signals are the ones `skill-usage.ts` counts, read back out of the library's tool
 * rows instead of live events: the `Skill` tool's own line, a path under `~/.talkcode/skills/`,
 * and a message the person started with `/<name>`. A tool row is one line, so a path cut off by
 * its 200-character preview is a miss — the skill still appears in the catalog, and a patch to a
 * skill whose text the reviewer was not given is refused by the version check rather than applied
 * blind.
 */
export function usedSkillNames(messages: Array<{ role: string; text: string }>, known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const add = (name: string | undefined): void => {
    if (name && known.has(name) && !out.includes(name)) out.push(name);
  };
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const match of message.text.matchAll(/\.talkcode\/skills\/([a-z0-9][a-z0-9-]*)/g)) add(match[1]);
      for (const match of message.text.matchAll(/\bSkill:\s*\/?([a-z0-9][a-z0-9-]*)/g)) add(match[1]);
      for (const match of message.text.matchAll(/"skill"\s*:\s*"([a-z0-9][a-z0-9-]*)"/g)) add(match[1]);
      continue;
    }
    if (message.role === 'user') {
      add(/^\/([a-z0-9][a-z0-9-]*)(?:\s|$)/.exec(message.text.trim())?.[1]);
    }
  }
  return out;
}

/**
 * Tool names that change a file, as the library records them: `Edit` is what claude-agent-acp's
 * `edit` kind becomes (Write included), `Write` is CodeBuddy's own, `edit_file`/`write_file` agy's.
 * Measured on the library 2026-11-06 over every tool row naming a skills path.
 */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'edit_file',
  'write_file',
  'apply_patch',
  'delete',
  'move',
]);

/**
 * A path to a file in a skill: `…/skills/<name>/<file>`. `skills` must be a whole path segment
 * (`quantlab-skills/work/…` is not a skill), and the path stops at quotes and braces, because an
 * agy edit's line is a JSON preview (`{"Path":"/…/skills/server-ops/…"`). Both cases were in the
 * library on 2026-11-06.
 */
const SKILL_PATH = /(?:[^\s"'`{}(),:]*\/)?(?<![\w.-])skills\/[a-z0-9][a-z0-9-]*\/[^\s"'`{}(),]+/g;

/**
 * The skill files the conversation's own agent wrote: a write-type call whose line names a path
 * under any `skills/<name>/`, whichever library it is in. Only the line is read — for these tools
 * it is the path — so a command that merely mentions a skill is not counted as writing one.
 */
export function writtenSkillFiles(calls: string[]): string[] {
  const out: string[] = [];
  for (const text of calls) {
    const newline = text.indexOf('\n');
    const line = newline < 0 ? text : text.slice(0, newline);
    const colon = line.indexOf(': ');
    if (colon < 0) continue;
    const who = line.slice(0, colon);
    const dot = who.lastIndexOf(' · ');
    const name = (dot < 0 ? who : who.slice(dot + 3)).trim().toLowerCase();
    if (!WRITE_TOOLS.has(name)) continue;
    for (const match of line.slice(colon + 2).matchAll(SKILL_PATH)) {
      if (!out.includes(match[0])) out.push(match[0]);
    }
  }
  return out.slice(0, 20);
}
