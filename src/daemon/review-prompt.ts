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

/** A skill file the conversation wrote, and what it holds now when the gateway can read it. */
export interface PromptWrittenFile {
  /** `<skill>/<file>` for one of the gateway's skills, else the path the write named. */
  path: string;
  /** The file as it is now. Absent for a path outside the library, or one too long to quote. */
  content?: string;
  /** Why there is no content, when there is a reason worth saying (`全文见上`, `太长，没有附上`). */
  note?: string;
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
   * Skill files the conversation already wrote, with their text. Named because the calls are not
   * in the log: on 2026-11-06 a review created `vlt` in the gateway's library an hour after the
   * person had asked the agent to write that very skill elsewhere, and did it. Quoted since
   * 2026-11-07: a review that day added a rule to server-ops' SKILL.md, twice, that the agent had
   * already written into one of its references during the conversation — the name alone did not
   * stop it, and a path from `talkcode skills write-file` was not recognised at all.
   */
  written?: PromptWrittenFile[];
  /** The categories the library already uses, for a `create` to pick from. */
  categories?: string[];
  /**
   * The rules agents already get (`instructions/`), so a preference the person set long ago is
   * not suggested again. Absent when there is none.
   */
  standing?: string;
  /**
   * What the agents in this conversation searched the skill library for and did not find
   * (skill-queries.ts): the clearest sign of a skill worth writing, said by the agent that needed it.
   */
  searchedFor?: string[];
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
    ? ['', '这段对话里已经写过的技能文件（下面是现在的内容，已经写进去的不要再写）', ...input.written.map(renderWritten)]
    : [];
  const standing = input.standing?.trim() ? ['', '用户已有的要求', input.standing.trim()] : [];
  const categories = input.categories?.length ? input.categories.join('、') : '运维、开发、协作';
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
    // The next two are from 2026-11-07. A review wrote a plan the person had agreed to but nobody
    // ran — later shown wrong in another conversation — into server-ops as a "must"; only a version
    // race kept it out. Another wrote one rule into SKILL.md twice, beside a reference that had it.
    '- 只记这段对话里做成并验证过的结论。只提了没执行的方案、没验证的推测、后来被推翻的说法，都不记。',
    '- 同一件事只写一处：已经写过的技能文件和技能全文里有的不再写。细节放参考资料，SKILL.md 里最多留一句指过去。',
    '- 技能按任务类别命名：小写加连字符。不要用日期、报错、分支名、一次性的任务名。',
    '- 不删技能。不记一次性的事：这次的具体报错、临时路径、单个 PR 都不算。',
    '- 只写对下一次同类任务有用的规则，不要抄对话原文。',
    '- 没什么可改就返回空清单。',
    '- 改已有的文件用 edit，不要整篇重写：old 从原文逐字照抄，在文件里只能出现一次；要加内容，就把插入点前后的一行放进 old，在 new 里接上新内容。原文里的反斜杠，在 JSON 里要写成两个。',
    '- write-file 只用来建新文件。',
    '- 不要动 frontmatter 里的 metadata：talkcode-resident 只有人能改，改了会被拒。',
    '- 不要调用任何工具，直接输出 JSON。',
    '',
    '输出',
    '{"changes":[…],"preferences":[…]}',
    'changes 里每一项是下面三种之一：',
    '{"action":"edit","name":"…","version":"技能库里的版本号","file":"SKILL.md 或 references/xxx.md","edits":[{"old":"原文里的一段","new":"改成什么"}],"reason":"为什么"}',
    '{"action":"write-file","name":"…","file":"references/xxx.md","content":"文件内容","reason":"为什么"}',
    '{"action":"create","name":"…","category":"分类","description":"一句话说明什么时候用","body":"SKILL.md 正文，不含 frontmatter","reason":"为什么"}',
    `create 的 category 从这些里选：${categories}；都不合适才另起一个，两到四个字。`,
    // Narrowed on 2026-11-07: the 26 suggestions of the first two days were all cleared from the
    // Reviews tab, and only two ever reached the instructions. The rest were about one project,
    // were an agent's idea the person had nodded at, or contradicted an earlier one.
    `preferences：用户在这段对话里亲口提出、换到别的项目也该照做的工作方式要求，每条一句话。只和某个项目、某台机器或这一次任务有关的不写；agent 提出、用户只是同意的不写${standing.length ? '；「用户已有的要求」里已经有的不写' : ''}。没有就空数组。`,
    '',
    '技能库（名字、版本、简介）',
    catalog,
    '',
    '这段对话用到的技能全文',
    used,
    ...written,
    ...standing,
    '',
    ...(input.searchedFor?.length
      ? ['智能体在技能库里搜过、没找到的', ...input.searchedFor.map((q) => `- ${q}`), '']
      : []),
    `对话记录：${input.title || '（无标题）'}，${span}，共 ${input.messages.length} 条，不含工具调用${dropped}`,
    conversation,
  ].join('\n');
}

function renderUsedSkill(skill: PromptSkillText): string {
  const files = skill.files.length ? `\n其他文件：${skill.files.join(', ')}` : '';
  return `### ${skill.name}（${skill.version}）\n${skill.content.trim()}${files}`;
}

function renderWritten(file: PromptWrittenFile): string {
  if (file.content !== undefined) return `#### ${file.path}\n${file.content.trim()}`;
  return `- ${file.path}${file.note ? `（${file.note}）` : ''}`;
}

const CreateChange = z.object({
  action: z.literal('create'),
  name: z.string().min(1),
  description: z.string().min(1),
  body: z.string().default(''),
  category: z.string().optional(),
  reason: z.string().optional(),
});

/**
 * Still parsed, never applied: an answer from before `edit` existed is read back by the Reviews
 * tab, and a reviewer that answers with one anyway is refused with a sentence saying so (review.ts
 * apply). A patch is the whole SKILL.md retyped — 18 000 characters to add two lines to server-ops'
 * 27 KB, on 2026-11-06, with an unrelated word changed on the way.
 */
const PatchChange = z.object({
  action: z.literal('patch'),
  name: z.string().min(1),
  version: z.string().min(1),
  content: z.string().min(1),
  reason: z.string().optional(),
});

/** How many replacements one `edit` may carry. */
export const MAX_EDITS = 20;

/**
 * Exact replacements in one file of a skill, against the version the reviewer was shown. Each
 * `old` has to occur exactly once, so an edit lands where the reviewer meant or not at all.
 */
const EditChange = z.object({
  action: z.literal('edit'),
  name: z.string().min(1),
  version: z.string().min(1),
  file: z.string().min(1).default('SKILL.md'),
  edits: z
    .array(z.object({ old: z.string().min(1), new: z.string() }))
    .min(1)
    .max(MAX_EDITS),
  reason: z.string().optional(),
});

const WriteFileChange = z.object({
  action: z.literal('write-file'),
  name: z.string().min(1),
  file: z.string().min(1),
  content: z.string().min(1),
  reason: z.string().optional(),
});

const Change = z.discriminatedUnion('action', [CreateChange, PatchChange, EditChange, WriteFileChange]);
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

/**
 * The gateway skill a written path is a file of — `…/skills/<name>/<file>` where `<name>` is in
 * `known` — so the review can quote it from the store. Any other path is not one of its skills.
 */
export function skillFileOfPath(p: string, known: ReadonlySet<string>): { name: string; file: string } | undefined {
  const m = /(?:^|\/)skills\/([a-z0-9][a-z0-9-]*)\/(.+)$/.exec(p);
  if (!m || !known.has(m[1]!)) return undefined;
  return { name: m[1]!, file: m[2]! };
}
