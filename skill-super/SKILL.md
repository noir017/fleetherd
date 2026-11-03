---
name: super
description: >-
  /super <job>: split a job into parts and hand them to other agents (sub-agents) that work in
  parallel, each in a topic of its own the person can open, then check and summarize what they
  did. Use when the person's message starts with /super, or when they ask for work to be split
  across agents.
---

# /super — hand the parts of a job to sub-agents

You coordinate; the sub-agents do the work. Their commands are `talkcode task-*` — run
`talkcode help tasks` once before the first one. Sub-agents open as topics nested under this
one in the web UI; the person confirms every start, and can talk to any of them directly.

## 1. Split

- Read what you need of the code to split the job well. Do not start doing it.
- Split it into parts that can run at the same time without stepping on each other: different
  repositories, different files, or questions that can be answered apart. One part is fine when
  the job does not split; do not invent parts.
- Two sub-agents in the same checkout edit the same working tree. Give parts in one repository
  disjoint files, or tell each to work in a `git worktree` of its own.

## 2. Propose

- `talkcode task-agents` lists the agents and where each runs. **Prefer `here=true`** — your own
  machine, with the same checkouts and tools. Use another machine only when the part needs it
  (a repository or a tool that only exists there), and say why on the card's title.
- One `talkcode task-new --agent <id> [--cwd <dir>] --title "<short name>" "<text>"` per part,
  back to back, so they land on one card.
- The text is everything the sub-agent will see — it has not read this conversation. Give it the
  goal, the constraints, and how it will know it is done (a test that passes, a command whose
  output changes). Not the steps: it will read the code and choose them.
- End your turn with one line saying what you proposed. Nothing starts until the person taps
  Start. If they write instead, they want changes: propose again — the new card replaces the old.

## 3. Follow

Updates arrive as messages beginning `[sub-agent updates]`, with how many are still working.

- **While it works**, `talkcode tasks` shows what each one is running now: the tool, the step it is
  on, how long the turn has gone and its context. `talkcode task-status <topic>` is one topic in
  detail, with its last three tool calls. A long tool list in `task-read` is cut at 1500 characters
  per message; `task-read <topic> --tail 20` shows the newest lines, `--full` the whole list.
- **Finished**: check the result itself — read the diff, run the tests — not its summary. If it
  is wrong or incomplete, `talkcode task-send <topic> "<what to fix>"`.
- **A question about what your task meant**: answer it with `task-send`.
- **Going the wrong way**: `task-send` alone only reaches the turn on a harness that takes input
  mid-turn; the answer says whether it joined or is waiting behind it. To stop it now,
  `talkcode task-send <topic> --interrupt "<what to do instead>"` — that ends the turn and sends
  your correction as the next one, with its context kept.
- **Anything the person has to decide** — scope, merging, releasing, deleting, spending — say it
  in one line here and stop. Do not decide it for them.
- **Failed**: if it looks transient (a dropped connection, an upstream error), `task-send` it
  `continue` once; otherwise report it.
- While others are still working, say nothing, or one line.

## 4. Report

When every part is done: one short summary — what changed and where, how you verified it, and
what is left for the person. Link each topic as `[title](<link>)`, with the `link` the updates and
`talkcode tasks` give (`?t=…`): that is what opens it in place.

Do not do a sub-agent's part yourself, and do not quietly redo or discard its work.
