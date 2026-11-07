# Skills the gateway keeps

English | [简体中文](zh-CN/skills.md)

A managed skill is a skill the gateway stores itself and gives to every agent on every host —
Claude Code, Codex, OpenCode, Antigravity, CodeBuddy and AtomCode, local or remote. An agent can
write one when you say "remember this as a skill", and every agent reads it from its next start.

```text
<config dir>/skills/                 (~/.config/talkcode/skills/) — a git repository
  skills/
    deploy-check/
      SKILL.md                       the skill: frontmatter (name, description) + body
      references/                    optional: what the skill reads
      templates/
      scripts/
  archive/                           archived skills, whole and unmodified
<config dir>/skills-usage.json       source, created, last use, uses, agents, status, pin
```

Every change is a commit, so a skill's history is the repository's log. Anything else in the
repository — a README, scripts of its own, `skills-alone/` — is left alone and is not delivered.

## The command

`talkcode skills <action>` is a reverse command, so an agent finds it through the bundled
`talkcode` skill and `talkcode help skills`. It is gateway-wide: `--channel` does not apply.

| action | what it does |
|---|---|
| `search <what you need>` | up to five skills that fit, best first — how an agent finds a library skill |
| `show <name> [file] [--again]` | one file (default `SKILL.md`, with the list of the skill's other files) and the version every `patch` must name |
| `list` | every skill, with tier, status, pin, uses, last use and the agents that used it |
| `categories` | how many skills, per category |
| `create <name> --description "<when to use it>" [--body <markdown>]` | a new skill |
| `patch <name> --version <v> --content <full SKILL.md>` | replace `SKILL.md`, only from the version read |
| `write-file <name> <path> --content <text>` | add or replace a file under `references/`, `templates/`, `scripts/` |
| `remove-file <name> <path>` | remove one of those files |
| `archive <name>` / `restore <name>` | move to `.archive/` and back |
| `pin <name>` / `unpin <name>` | keep a skill out of (or back in) the expiry check |
| `history <name>` | every recorded content change, newest first |
| `revert <name> <id>` | put the files from one change back, as a new change |

### Rules

- **Names** are lowercase words joined by hyphens (`a-z`, `0-9`), at most 64 characters. `talkcode`
  and `super` are the bundled skills and cannot be reused.
- **`SKILL.md`** is at most 64 KB and must start with `---` frontmatter naming the skill and giving a
  non-empty one-line description. That is what a harness lists in its skill menu.
- **Extra files** go only in `references/`, `templates/` or `scripts/`, at most 1 MB each. A script
  is delivered executable; everything else is read-only.
- **Read before write.** `patch` carries the version `show` printed. If the skill changed in
  between, the patch is refused and says the current version — run `show` again, re-apply the edit,
  and patch with the new number. `write-file` and `remove-file` do not need a version; each still
  makes a new one.
- **Nothing is deleted.** `archive` moves a skill into `archive/`; `revert <name> <id>` puts back the
  files as they were just before commit `<id>` — the gateway's or a person's. Both are commits, and
  `revert` can itself be reverted.

## The repository

Without configuration the repository is local, under the config directory. Point it at a shared
one and the gateway keeps the two in step:

```yaml
skills:
  repo: ssh://git@git.example:22/you/agent-skills.git
  branch: main                     # optional; main by default
```

- **Fetched** every five minutes and before every write, so a `patch` is checked against the
  newest version — a person's commit refuses a stale edit exactly as another agent's would.
- **Pushed** after every write, while the turn that made it is still waiting. The author says who
  wrote it: `talkcode` for an agent, `talkcode-review` for the [automatic review](#auto-review),
  `talkcode-web` for the web UI's page. The commit's trailers name the agent and the conversation.
- **Edited by hand** like any repository: commit and push, and the gateway picks it up within five
  minutes. A hand-written skill that breaks the rules below is not delivered; `list` says why.
- **Unreachable**: a write still lands locally and is pushed later; the log says once when the
  repository stops answering and once when it answers again.
- **Both sides changed one file**: the repository's version wins. The gateway's commits are kept on
  a branch named `talkcode-unpushed-<time>` and pushed there, and the log names it. Nothing is
  force-pushed.

An ssh URL is reached the way a [remote host](remote-hosts.md) is: the gateway's own key
(`<config dir>/ssh/id_ed25519`) and known_hosts (`<config dir>/ssh/known_hosts`), no ssh config of
the machine's, and strict host key checking — put the repository host's key in that known_hosts
first; the gateway never learns one. `identityFile` and `knownHostsFile` under `skills:` point
elsewhere. `talkcode doctor` checks git and the repository. A `/reload` that changes `skills:`
takes effect at the next fetch.

The gateway needs `git` (the container image has it). The first start with this version moves an
old store into a repository as one commit and keeps the old directory as `skills.pre-git`.

## Resident and library

A skill is in one of two tiers, set in its own frontmatter:

```yaml
---
name: server-ops
description: Use when operating a fleet server — SSH, EasyTier, backups.
metadata:
  talkcode-resident: "true"        # absent: the library
  talkcode-category: "运维"
  talkcode-hosts: "uniagent, awsfree2"   # optional: only agents on these hosts get it
  talkcode-harnesses: "claude, codex"    # optional: only these harnesses get it
---
```

- **Resident** skills are linked into every harness's skill directory, so every agent sees their
  name and description on every request. That is why the description is held to **120
  characters** — written as "Use when …" — and why only a person makes a skill resident: the web
  UI's **Resident** / **Library** switch, or a commit. A `patch` from an agent or from the
  review that changes `talkcode-resident` is refused.
- **Library** skills are everything else. They are delivered to every host like a resident one but
  linked nowhere, so they cost no context until an agent looks one up with the `skills` tool. A
  skill an agent or the review creates starts here.
- **Category** groups skills; the `skills` tool's description ends with the library skills that
  reach that agent, by category (`In the library: 协作: grilling, siyuan-notes; other: email-reader.`),
  which is what tells an agent there is something worth a `show` before it starts. Past 40 names it
  says how many each category holds instead (`In the library: 运维 6, 开发 2, other 3.`), so a
  large library does not grow every request. **Hosts** and **harnesses** (a host is a `hosts:` id,
  or `local`; a harness is `claude`, `codex`, `opencode`, `agy` or `codebuddy`) keep a skill off
  the agents it would only mislead.

The values are quoted strings because the Agent Skills spec makes `metadata` a map of strings, so
a harness that checks the spec lists the skill unchanged.

## Finding a skill: the `skills` tool

Every agent has a `skills` tool beside `send_file` and `schedule` (an agent without native tools
runs `talkcode skills search` / `show`, which is the same thing):

- **search** — what it needs, in a few words, in any language. Up to five skills come back, best
  first, without the tail that scores under 40% of the best one: name, description, category, tier, and where the files are on its machine. A resident hit
  says it is already in the agent's own list. Ranking is BM25 over the name, description, category
  and body, the description weighted above a passing mention in a body; Chinese is matched by
  two-character words, so 「部署检查」 finds a skill about 「检查部署」. Only skills that reach the
  asking agent (its host and harness) are searched.
- **show** — one skill: `SKILL.md` whole, with the list of its other files, which `file` reads.
  Reading counts as a use. A version this conversation already read comes back as "unchanged"
  instead of the whole text again, until `/new` or a change; `--again` reads it anyway, for an
  agent whose context was compacted since.

A skill created after an agent started is searchable and readable at once; its files reach that
agent's machine at the agent's next start.

**Searches that found nothing** are where the library falls short. The web UI's skills page lists
them, and the searches whose hits nobody opened (the descriptions did not say "this is the one");
the [automatic review](#auto-review) is shown the ones from the conversation it reviews, as a hint
for a skill worth writing. They are kept in `<config dir>/skills-queries.jsonl`.

## From the web UI

**Skills** in the web UI's **⚙ Menu** at the foot of the topic list. It lists every managed skill
under two tabs, **Library** and **Resident**, each with its count; an off skill stays in its tier's
tab, listed last. A row shows whether the skill is pinned, its category, and when it was last
used; the Library tab ends with the searches that found nothing. Every row carries two switches,
so neither needs the skill opened:

- **Resident** / **Library** puts a skill in every agent's list or takes it out to the library; a
  description over 120 characters is refused until it is shortened. An off skill's tier is greyed
  out: it comes back where it was.
- **On** / **Off** turns a skill off, which is `archive` — the skill moves into `archive/` whole and
  is delivered to no agent — and on again, which is `restore`. One tap, because the same tap undoes
  it. Nothing in the gateway hard-deletes a skill, and the page has no such operation.

A switch moves the moment it is tapped and the change is saved behind it; a refusal puts it back
and says why. The row stays in its tab until the page is next opened. Agents pick up either change
when they next start; a library search sees it at once. The name
opens the skill for editing, with the same two switches beside **Pin**:

- **New** creates a skill from a name, a one-line description and an optional body.
- **Edit** changes `SKILL.md` or any file under `references/`, `templates/` or `scripts/`;
  **New file** adds one. Saving `SKILL.md` carries the version the page read, so the same
  read-before-write rule as `patch` applies, and a refusal says the current version.
- **History** lists every commit that touched the skill; **Restore this version** is `revert`, and
  is itself recorded as a new change.

It is the same store and the same rules as `talkcode skills`, because every write goes through
`skills-store.ts`. Turning a skill off from the page also tells the conversation that created it,
exactly as archiving from a chat does. A commit someone made by hand shows its author, and can be
restored too.

## How it reaches an agent

At every agent start the gateway copies each active skill that reaches the agent to
`~/.talkcode/skills/<name>/` on the machine the agent runs on, then links each **resident** one into
the directory that harness reads (a library skill stays a copy, for the `skills` tool to point at):

| agent | its skills directory |
|---|---|
| Claude Code | `~/.claude/skills` |
| Codex, OpenCode | `~/.agents/skills` |
| Antigravity (agy) | `~/.gemini/config/skills` |
| CodeBuddy Code | `~/.codebuddy/skills` |

The copy is read-only, so an agent that wants to change a skill has to use `talkcode skills` —
where the change is versioned and can be reverted — instead of editing the copy that the next
start would overwrite.

Only a link pointing into `~/.talkcode/skills` is ever repointed or removed. A real directory, a
real file, or a link of your own at `~/.claude/skills/<name>` stays as it is, and the log says that
agent does not get the managed copy. An unchanged version is not written again. An archived skill
has its copy and every link of the gateway's taken back at the next start; a skill moved to the
library has its links taken back and keeps its copy.

## When a skill counts as used

Four signals, all from events the gateway already receives:

1. an agent calls the skill as a `Skill` tool (Claude Code, CodeBuddy);
2. a message starts with `/<name>`;
3. any tool call mentions a file under `~/.talkcode/skills/<name>/` — how Codex, OpenCode, agy and
   AtomCode read a skill, and how a reference or script under it counts;
4. an agent reads it with `show` (the `skills` tool, or `talkcode skills show`) — how a library
   skill is used.

A turn counts a skill once however many times it appears through the first three. The rest of
`talkcode skills` is management, not use, and does not count.

## Expiry and archive

Once a day the gateway checks every skill an agent or the review created: **14 days** without a
use marks it expired, **30 days** moves it into `archive/` and takes it off every agent at its next
start. A pinned skill is left alone, and so is every skill a person wrote — committed by hand or
made on the web UI's page — because the gateway cannot see it read from a terminal. An archived skill is never deleted; `restore` brings it back with its clock reset, and the
conversation that created it is told when it is archived.

A skill used from a terminal is not counted, because no gateway turn saw it used. That is the one
blind spot; pin an agent-written skill if it matters and the check would otherwise archive it.

## Any agent can write one

That is the point — "remember this as a skill" works in the conversation where you said it — and
also the risk: a managed skill enters **every** agent's context, so an agent that writes one is
writing instructions the others will follow. The guards are the validation above, the history and
`revert`, the archive notice, and the 30-day archive. Keep the access list to people you trust —
and, with `skills.repo` set, the repository's write access too: whoever can push to it is writing
into every agent's skills as well.

## Auto review

A conversation that goes quiet can teach the library something: a step that was missing, a
mistake the person corrected, a technique worth keeping. Turn it on by naming the agent that does
the reviewing — it must be an `agy` agent, and a review is one `agy -p` on the machine that agent
runs on:

```yaml
review:
  agent: ag@uniagent             # off unless this is set
  model: gemini-3.8-flash-high   # optional; the agent's own model otherwise
```

Both fields are also [settings from chat](settings.md): `/setting review.agent ag@uniagent`
turns it on, `/setting review.agent off` turns it off, and `/setting review.model` chooses a
model for reviews alone. The row offers only `agy` agents, because a review runs `agy -p` with
every tool denied; a change is read at the start of the next sweep, within a minute, without a
restart.

A review runs when a conversation has been idle for an hour, nothing is running there, and the
person has sent at least three messages since the last review. In practice it fires the moment
[idle reclaim](chat-commands.md) stops the agent process; `/kill` and `/new` are
reviewed an hour later, a gateway restart backfills whatever went quiet while it was down, and a
conversation whose agent can never be reclaimed (reclaim off, or a harness that cannot resume a
session) is reviewed with its process still up. Scheduled tasks, sub-agents and reviews themselves
are never reviewed.

The reviewer gets the conversation without its tool calls — every message you sent, then the
agent's replies newest first up to the cap — the skill list with versions and the categories in
use, the full text of the skills that conversation used, the skill files that conversation already
wrote, with what they hold now (so it neither creates a second copy of a skill you just had written
nor adds a rule the agent already put in a reference), and every file of your
[instructions for agents](instructions.md) (so it does not suggest a preference you already
set). It has no tools: it runs in an empty temporary directory with every
tool denied, so it cannot read or write anything. It answers with a JSON list of changes, each with
a reason, plus any preferences it noticed:

- `edit` — exact replacements in `SKILL.md` or one of its files: each quoted original must occur
  exactly once, against the version the reviewer was given, or the change is refused. A review
  never retypes a whole file.
- `write-file` — a new reference, template or script; one that already exists is refused.
- `create` — a new skill, in the library, under a category.

It is told to record only what the conversation actually did and verified — not a plan nobody
ran, a guess, or something later overturned — and to say each thing in one place. Preferences are
held to what you said yourself and would want in any project. The gateway applies the changes
through the same rules as `talkcode skills`, and a change that fails is dropped and logged. The
reviewer itself never touches a file.

When something changed, one line appears in the conversation that was reviewed:

```text
📝 复盘：更新技能 `deploy-check`（回滚 `talkcode skills revert deploy-check c4f06d73eaad`）。偏好建议：回答先给结论
```

No change, no line. One review runs at a time, and one gets up to 30 minutes: a provider that
queues a request for minutes, or that agy is already retrying, is waited out rather than cut off.
A conversation this feature has never seen is reviewed only when its newest message is under 24
hours old — so turning this on for the first time reads the recent tail, not months of history;
once it has a record (reviewed or failed), its watermark and the retry schedule decide. A failed
review waits six hours before it is tried again, and the same batch of messages gets at most three
attempts; after the third failure the review gives up, moves past that batch, and waits for three
new messages. The exception is the provider having no capacity for the model — `No capacity
available`, or `UNAVAILABLE` with a `503`, in what agy answered — or a run that reaches the
30-minute limit: agy retries a 503 itself, has no give-up limit, and can still be waiting when the
review is killed, leaving nothing to read. That is not counted as an attempt and is retried in an
hour. A failure that fails at once — no such host, a spawn failure, ssh refused — never reaches the
limit and stays an ordinary, counted failure. The exemption stops after twelve capacity failures in a
row (about 18 hours: each is an hour's wait plus up to 30 minutes); from then on they count, and
the batch can be given up on like any other. A conversation waiting on capacity goes behind fresh
ones, and a sweep stops starting new reviews after 40 minutes — the one already running may take
up to 30 more — so a run of starved batches cannot make one pass endless. There is no daily cap,
because each conversation's watermark already stops it being reviewed twice. Reviews are filed in
the conversation library as `review` sessions, which search and `list` leave out.

**Where the results are.** The web UI's side panel has a **Reviews** tab: every review, including
the ones that changed nothing and posted no line. Above them, **Suggested preferences** gathers the
preference suggestions no one has dealt with: one entry per wording, with how many reviews made it
and which conversations they came from. None of them is in force anywhere — **Adopt** one and a new
topic opens with a draft asking an agent to add it to your instructions (edit it, switch agent
first, or throw it away; the suggestion leaves the list only when a message that still carries it
is sent there), and **Dismiss** the rest (or the ones you added); a dismissed suggestion does not
come back. A row is the reviewed conversation, when, and
what happened — a skill created or updated, only preference suggestions, a change the store
refused, nothing found, or a failed run. Opening it shows each change with the reviewer's reason,
whether it actually took effect (and the store's sentence when it did not), the preference
suggestions in full, and the `talkcode skills revert` / `archive` command that undoes a change.
A row whose reviewed conversation is still in the topic list links back to it. Reviews recorded
before results were kept show only what the raw answer proposed, marked **inferred**: nothing in
the library says whether those changes were applied.
