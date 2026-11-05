# Skills the gateway keeps

English | [简体中文](zh-CN/skills.md)

A managed skill is a skill the gateway stores itself and gives to every agent on every host —
Claude Code, Codex, OpenCode, Antigravity, CodeBuddy and AtomCode, local or remote. An agent can
write one when you say "remember this as a skill", and every agent reads it from its next start.

```text
<config dir>/skills/                 (~/.config/talkcode/skills/)
  deploy-check/
    SKILL.md                         the skill: frontmatter (name, description) + body
    references/                      optional: what the skill reads
    templates/
    scripts/
  .usage.json                        source, created, last use, uses, agents, status, pin
  .archive/                          archived skills, whole and unmodified
  .history/                          the version before every change, one directory per change
```

The dot entries are the gateway's bookkeeping, not skills.

## The command

`talkcode skills <action>` is a reverse command, so an agent finds it through the bundled
`talkcode` skill and `talkcode help skills`. It is gateway-wide: `--channel` does not apply.

| action | what it does |
|---|---|
| `list` | every skill, with status, pin, uses, last use and the agents that used it |
| `show <name> [file]` | one file (default `SKILL.md`) and the version every `patch` must name |
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
- **`SKILL.md`** is at most 20 KB and must start with `---` frontmatter naming the skill and giving a
  non-empty one-line description. That is what a harness lists in its skill menu.
- **Extra files** go only in `references/`, `templates/` or `scripts/`, at most 1 MB each. A script
  is delivered executable; everything else is read-only.
- **Read before write.** `patch` carries the version `show` printed. If the skill changed in
  between, the patch is refused and says the current version — run `show` again, re-apply the edit,
  and patch with the new number. `write-file` and `remove-file` do not need a version; each still
  makes a new one.
- **Nothing is deleted.** `archive` moves a skill; `revert` replaces files with an older snapshot.
  Both are recorded in `.history/`, and `revert` can itself be reverted.

## From the web UI

**Skills** in the web UI's **⚙ Menu** at the foot of the topic list. It lists every managed skill with its
status, whether it is pinned, and when it was last used, and opens one for editing:

- **New** creates a skill from a name, a one-line description and an optional body.
- **Edit** changes `SKILL.md` or any file under `references/`, `templates/` or `scripts/`;
  **New file** adds one. Saving `SKILL.md` carries the version the page read, so the same
  read-before-write rule as `patch` applies, and a refusal says the current version.
- **History** lists every recorded change; **Restore this version** is `revert`, and is itself
  recorded as a new change.
- **Delete** is `archive` — the skill moves into `.archive/` whole and can be restored from the
  same page. Nothing in the gateway hard-deletes a skill, and the page has no such operation.

It is the same store and the same rules as `talkcode skills`, because every write goes through
`skills-store.ts`. Archiving from the page also tells the conversation that created the skill,
exactly as archiving from a chat does.

## How it reaches an agent

At every agent start the gateway copies each active skill to
`~/.talkcode/skills/<name>/` on the machine the agent runs on, then links it into the directory
that harness reads:

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
has its copy and every link of the gateway's taken back at the next start.

## When a skill counts as used

Three signals, all from events the gateway already receives:

1. an agent calls the skill as a `Skill` tool (Claude Code, CodeBuddy);
2. a message starts with `/<name>`;
3. any tool call mentions a file under `~/.talkcode/skills/<name>/` — how Codex, OpenCode, agy and
   AtomCode read a skill, and how a reference or script under it counts.

A turn counts a skill once however many times it appears. `talkcode skills` itself is management,
not use, and does not count.

## Expiry and archive

Once a day the gateway checks every skill: **14 days** without a use marks it expired, **30 days**
moves it into `.archive/` and takes it off every agent at its next start. A pinned skill is left
alone. An archived skill is never deleted; `restore` brings it back with its clock reset, and the
conversation that created it is told when it is archived.

A skill written from a terminal is not counted, because no gateway turn saw it used. That is the
one blind spot; pin the skill if it matters and the check would otherwise archive it.

## Any agent can write one

That is the point — "remember this as a skill" works in the conversation where you said it — and
also the risk: a managed skill enters **every** agent's context, so an agent that writes one is
writing instructions the others will follow. The guards are the validation above, the history and
`revert`, the archive notice, and the 30-day archive. Keep the access list to people you trust.

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

A review runs when a conversation has been idle for an hour, nothing is running there, and the
person has sent at least three messages since the last review. In practice it fires the moment
[idle reclaim](chat-commands.md) stops the agent process; `/kill` and `/new` are
reviewed an hour later, a gateway restart backfills whatever went quiet while it was down, and a
conversation whose agent can never be reclaimed (reclaim off, or a harness that cannot resume a
session) is reviewed with its process still up. Scheduled tasks, sub-agents and reviews themselves
are never reviewed.

The reviewer gets the conversation (capped), the skill list with versions, and the full text of the
skills that conversation used. It has no tools: it runs in an empty temporary directory with every
tool denied, so it cannot read or write anything. It answers with a JSON list of `create`, `patch`
and `write-file` changes, each with a reason, plus any preferences it noticed. The gateway applies
them through the same rules as `talkcode skills` — a patch must carry the version the reviewer was
given, and a change that fails is dropped and logged. The reviewer itself never touches a file.

When something changed, one line appears in the conversation that was reviewed:

```text
📝 复盘：更新技能 `deploy-check`（回滚 `talkcode skills revert deploy-check 0000000000172-abc123`）。偏好建议：回答先给结论
```

No change, no line. One review runs at a time and at most ten a day (UTC), so a quiet library
cannot spend the reviewer's quota; a failed review waits six hours before it is tried again.
Reviews are filed in the conversation library as `review` sessions, which search and `list` leave
out.
