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
one in the web UI; by default the person confirms every start, and can talk to any of them
directly.

## 1. Split

- Read what you need of the code to split the job well. Do not start doing it.
- Split it into parts that can run at the same time without stepping on each other: different
  repositories, different files, or questions that can be answered apart. One part is fine when
  the job does not split; do not invent parts.
- Two sub-agents in the same checkout edit the same working tree. Give parts in one repository
  disjoint files, or tell each to work in a `git worktree` of its own.
- A part that changes code needs a review before you call it done. Propose it once the change is
  in: a sub-agent of its own, the same checkout, told to read the diff and run the tests. You read
  the verdict, not the diff.

## 2. Propose

- Unless the person named an agent, every part goes to the agent answering this conversation —
  you: leave `--agent` out. When they named one, or a part needs another machine (a repository or
  a tool that only exists there), `talkcode task-agents` lists the agents and where each runs.
  Prefer `here=true` — your own machine, with the same checkouts and tools — and say why on the
  card's title when a part goes elsewhere.
- One `talkcode task-new [--agent <id>] [--cwd <dir>] --title "<short name>" "<text>"` per part.
  With confirmation on, they all land on the card waiting for the person, however far apart you
  send them; only the first waits a few seconds for the rest. With it off where the person talks to
  you directly, each starts at once and the card lists what started.
- `--model <id>` runs a part on another model from that agent's `/model` list — when the person
  asked for one, or a part plainly needs a stronger or a cheaper one. Otherwise leave it out. The
  model decides what the part costs, so the card shows it; an id the agent does not offer is
  refused, with the list.
- The text is everything the sub-agent will see — it has not read this conversation. Give it the
  goal, the constraints, and how it will know it is done (a test that passes, a command whose
  output changes). Not the steps: it will read the code and choose them.
- Ask for the reply you will read: the conclusion first, then the evidence, under 2,000 characters.
  Say it in the text — the sub-agent gets nothing else. A review part also gets what to check and
  that its verdict comes first.
- End your turn with one line saying what you proposed. With confirmation on, nothing starts until
  the person taps Start; if they write instead, they want changes — propose again and the new card
  replaces the old. With it off (in a conversation the person talks to directly), each `task-new`
  starts at once and its result says so; a comment does not mean re-propose.

## 3. Follow

Updates arrive as messages beginning `[sub-agent updates]`, with how many are still working.

- **While it works**, `talkcode tasks` shows what each one is running now: the tool, the step it is
  on, how long the turn has gone and its context. `talkcode task-status <topic>` is one topic in
  detail, with its last three tool calls. `task-read <topic>` reads its messages from the
  conversation library, cut at 1500 characters each; `--reply` the last finished reply whole,
  `--tail 20` the newest lines, `--full` raises the per-message cut.
- **Finished**: read its reply — the conclusion and the evidence it names. If it changed code,
  propose its review now, with `task-new`; do not read the diff or run the tests yourself. If it is
  wrong or incomplete, `talkcode task-send <topic> "<what to fix>"`.
- **A question about what your task meant**: answer it with `task-send`.
- **Going the wrong way**: `task-send` alone only reaches the turn on a harness that takes input
  mid-turn; the answer says whether it joined or is waiting behind it. To stop it now,
  `talkcode task-send <topic> --interrupt "<what to do instead>"` — that ends the turn and sends
  your correction as the next one, with its context kept.
- **Anything the person has to decide** — scope, merging, releasing, deleting, spending — say it
  in one line here and stop. Do not decide it for them.
- **Failed**: if it looks transient (a dropped connection, an upstream error), `task-send` it
  `continue` once; otherwise report it. Its whole error is in the turn the card names —
  `task-read <topic> --turn <n>` — even when the card's quote was cut.
- While others are still working, say nothing, or one line.

## 4. Report

When every part is done: one short summary — what changed and where, how you verified it, and
what is left for the person. Link each topic as `[title](<link>)`, with the `link` the updates and
`talkcode tasks` give (`?t=…`): that is what opens it in place.

Do not do a sub-agent's part yourself, and do not quietly redo or discard its work.
