# Sub-agents (`/super`)

English | [简体中文](zh-CN/sub-agents.md)

Some jobs split: two repositories to change, a fix and its review, three questions to look into.
`/super` lets the agent you are talking to split the job, hand the parts to other agents that work
in parallel, and come back with one report — so you follow one topic instead of four.

```
/super upgrade the API client in shop-api and shop-web, and have cx review both
```

## What happens

1. The agent reads what it needs and splits the job. Each part goes to the same agent, in a topic
   of its own, unless you named another or the part needs another machine; it writes the task that
   agent will get. It asks for a reply it can act on: the conclusion first, then the evidence, under
   2,000 characters.
2. A card lists every part: the agent, its machine, the model and settings if any were chosen, the
   directory, and the full text of the task.
   **Nothing starts until you tap Start** — unless confirmation is off (`/setting delegation off`),
   in which case each part starts as it is proposed and the card is posted after it, listing what
   started and where, with no Start button. The middle tier (`/setting delegation first`) asks once
   per agent in a conversation: after you have confirmed that agent once here, its later parts
   start at once. Both relaxed tiers apply only where you talk to the agent directly:
   in a sub-agent's own topic, `task-new` still puts up the card, so agents cannot open more agents
   without you. With confirmation on, to change something, write what instead of tapping, and it
   proposes again; the new card replaces the old one. A part that changes code carries its review
   on the same card: the reviewing agent and the whole of what it will be told, run without the
   agent in between (see [Automatic review](#automatic-review)). The whole suite runs once, before
   merging, not in every part and every review.
3. Each part gets a topic of its own, nested under this one, and they run at once — up to four
   cold starts per machine, the rest waiting their turn. Starting a harness process costs several
   CPU-seconds and a few hundred MB before it answers, so a large card started together used to
   time out every part. The first message in each says which topic it came from.
4. When a sub-agent finishes, fails or asks something, the agent that started it is told. A folded
   🔔 line in its topic shows exactly what it was told. A topic whose turn ended normally is marked
   `turn ended`, not finished: a sub-agent can end its turn while a command it started is still
   running in the background, and its reply is where that is said. The notice quotes what the
   sub-agent said in full when it fits the card's budget — the reply, the question or the error,
   line breaks kept —
   so the agent can act on the conclusion without opening the topic. A cut adds one line with the
   text's full length and where the rest is: the card names the turn it quoted, and `task-read
   <topic> --turn <n>` reads that turn back — its reply with `--full`, a failed turn's whole error
   as the turn's record — because the ❌ notice in the topic carries only its opening. Reading by
   turn number, not "the last one", is what keeps a later background burst from taking its place. A
   burst longer than 20 sub-agents is one card with the rest folded into a line pointing at
   `fleetherd tasks`. The agent reads each reply's conclusion and each review's verdict, and
   sends fixes where needed; it does not read the diff itself. When every part is done, it writes
   one summary with a link to each topic.

## Talking to a sub-agent

A sub-agent's topic is an ordinary topic: open it, read it, write in it, `/stop` it. When a turn you
started there ends — or a turn you wrote into while it ran — the agent that opened the topic is told,
the same way as for the work it handed over: the update quotes what you wrote, marked as written to
the sub-agent directly, then the sub-agent's reply. Your words are cut at 2,000 characters, saying
so and where the rest is; attachments are listed by name, and a voice message is the transcript you
confirmed. Each round you have there is one update when it ends, so the agent stays current with what
you changed; rounds that end within a few seconds of each other, or of other sub-agents' news, share
one. A turn you `/stop` is not reported, but what you wrote stays for the next update from that topic.
Only the topic's own parent is told: a topic a sub-agent opened reports to that sub-agent.

To stop the whole job, use **Stop** (or `/stop`) in the topic you started it from: it stops that
topic and every sub-agent it started that is still working, theirs included. Stop is shown there
while any of them works, even after the agent's own turn has ended. Each conversation is kept.

Questions: one a sub-agent asks with buttons waits for you, moves to the top of the topic list
and is notified. One about what its task meant is answered by the agent that started it; anything you
need to decide — scope, merging, releasing, deleting — is passed to you.

## Watching and redirecting one

The agent that started a sub-agent can see what it is doing without opening its topic: `tasks` shows
the tool it is running, how many steps into the turn it is, how long that turn has run, and the
context it has used; `task-status` gives one topic's last three tool calls. `task-read <topic>` reads
the topic from the conversation library — the same rows `sessions read` reads, with the same
`--role`/`--turn`/`--turns`/`--since`/`--grep` filters. `--reply` gives the last turn that ended
normally, its reply whole; `--full` raises the per-message cut and `--tail <n>` keeps the last `n` lines of each message,
so an hour-long turn is not a black box.

When a sub-agent is going the wrong way, `task-send --interrupt` stops the turn it is running and
sends the correction as the next one. Its conversation is kept: it carries on with the context it
already had. Without `--interrupt`, a message reaches a running turn only on harnesses that take
input mid-turn; elsewhere it waits for the turn to end, and the agent is told which happened.

A review verdict reaches the agent that must act on it without being retyped: `task-send <topic>
--forward <review topic> "<what to fix>"` attaches the review topic's last normally-ended reply
whole, under a heading that names the topic and its turn. Both topics must be ones that
conversation opened. In the target topic the reply is shown as a folded **Sub-agent report** bubble
(one row per line, tap to open); the agent receives it whole. Like the other `task-*` commands,
this is web UI only.

## Automatic review

A part that changes code can be proposed with its review attached: `task-new --review-by <agent>
--review "<what to check>"`. The reviewer and its text are on the card with the part, and your Start
covers both. From then on the review runs without the agent that set it up:

1. Whenever a turn of the part ends normally with **new commits** in its directory, the reviewer gets
   the part's reply under a heading naming the commit range (`commits 3f2a…..9c1d… on feat/x`) — the
   first time in a topic of its own beside the part, opened in the same directory with the review
   text. A turn that commits nothing starts no review: a research part, or one that stopped to ask,
   is reported as usual.
2. The reviewer ends its turn with `fleetherd task-verdict pass | nits | changes`.
   - `pass` ends it.
   - `nits` sends its reply to the part to fix, with no further review.
   - `changes` sends it back; the part's next commits go to the **same** reviewer, as the new range
     only — at most `--rounds` times (3 by default).
3. The agent that set it up is told once, about both topics together: when the review passes, or as
   soon as the loop cannot go on by itself — a turn with no new commit or no reply, a review with no
   verdict, the rounds used up. A failure or a question reaches it as it always did. Writing in
   either topic yourself, or the agent's `task-stop`, ends the loop: the part is yours (or the
   agent's) again.

What the gateway sends in the loop is the other side's reply under a heading — the topic, its
turn, and the commit range or the verdict — and nothing of its own. Each step is shown in the topic
that set it up as a folded 🔁 line, without running a turn there; `tasks` has a `review` column
saying where each loop stands. The reviewer must run on the part's machine. Loops are persisted in
`<configDir>/review-loops.json` (0600, atomic rename on every change) and restored at startup,
dropping any loop whose topics no longer exist: after a restart, `task-verdict` is still accepted,
the work's next commits still go to the reviewer, and `tasks` still shows the loop. A turn cut off
by a restart is handled as any cut-off turn is today.

## In the sidebar

- Sub-agent topics are indented under the topic that opened them. **▾ 3** folds them away; folded,
  it takes the colour of the most pressing state among them (a question, a failure, work).
- A sub-agent's finished replies and failures do not move it to the top or notify you: the agent
  that started it reads those and reports. Its questions do. Its row keeps the ordinary idle/online
  dot when it finishes — only a topic you are meant to read takes the green "finished" dot, and
  that is the topic that started it, once the agent's answer is waiting for you.
- Deleting a topic keeps the topics it opened, as ordinary topics.

## Notes

- Web UI only: the topics have to be nested somewhere you can see them. `/super` is in the web UI's
  command list and nowhere else's; typed on another platform it is answered with that, and no turn
  runs.
- In the web UI, a card about sub-agents and the task text a sub-agent's topic receives carry a
  **Sub-agent task** tag, and the 🔔 update card a **Sub-agent report** tag. The text itself is
  unchanged, and every other platform shows it as sent.
- Any agent can propose sub-agents when you ask it to split work, without `/super`, and any
  configured agent can be one. The card waits for your tap by default.
- `/setting delegation` has three tiers. `on` (the default) asks before every sub-task. `first`
  asks once per agent in a conversation: after you tap Start on a card that included that agent,
  later sub-tasks for it there start at once — a batch mixing confirmed and new agents starts the
  former and puts only the latter on the card. That memory lives in the gateway's process and per
  conversation, so a restart or another conversation asks again; changing the setting, in either
  direction, forgets it too. `off` (or
  `delegation.confirm: false`) starts every sub-task as the agent proposes it and posts the card
  afterwards as a record. All three reach only conversations you talk to directly — a sub-agent's
  own topic still confirms every time. Only you can change it — no agent command reaches it.
- A caller outside the gateway can propose sub-tasks too, from a topic of its own, through the
  [MCP entrance](external-mcp.md). Its cards always wait for Start, whatever this setting says.
- A part can run on another model from the agent's `/model` list, when you ask for one or the
  part plainly needs it (`task-new --model`). The card names it, because the model decides what the
  part costs. A model the agent does not offer is refused when proposed; one the agent cannot
  switch to when the part starts fails that part, with the reason, in its topic and on the card —
  it never runs on another model instead. The topic keeps that model, as if chosen there with
  `/model`.
- A part can also pick the agent's own settings — the ones its settings switch offers, such as the
  account an agent works under (`task-new --option account=alice@example.com`, several as
  `key=value,key=value`). The card shows them after the model. A setting or value the agent does not
  offer is refused when proposed, with the choices it does offer and their notes (an account's quota,
  say); one the agent refuses when the part starts fails that part, with the reason — it never runs
  on the agent's default instead. The model is `--model`'s, not `--option`'s.
- **Isolated git worktrees (`task-new --worktree [<name>]`)**: when two parts work in the same
  repository, passing `--worktree` (optionally naming it; defaults to a slug of `--title`) tells the
  gateway to create `<repo root>/.worktrees/<name>` on a new branch `<name>` from the repository's
  current `HEAD` on the machine that runs the part, and start the part there. Validation runs at
  proposal time (refusing non-git directories and existing worktree or branch names), but nothing is
  created until the part actually starts; the confirmation card shows the planned path and branch.
  If `.worktrees/` is not already ignored, the gateway adds it to `.git/info/exclude` without
  editing a tracked `.gitignore`. Created worktrees are persisted in `<configDir>/worktrees.json`
  and checked by a periodic 15-minute sweep: a worktree is removed (`git worktree remove` without
  `--force`, then `git branch -d`) only when its branch is merged into the branch it was made from,
  its tree has no uncommitted or untracked changes, no turn is running or waiting on a question, and
  at least 1 hour has passed since its last turn ended. Everything else is left untouched and shown
  in the `worktree` column of `fleetherd tasks`.
- An agent can look one agent up before it proposes: `task-agents <agent>` lists that agent's
  models (marking the default), every setting with its values and the agent's note on each, its
  permission level, how many turns are running on it right now, and whether it is waiting out a
  usage limit. It starts a session of that agent to ask — running no prompt — so it takes a few
  seconds on a cold agent; plain `task-agents` lists every agent from the config alone.
- With agents on several [machines](remote-hosts.md), a part goes to another machine only when it
  needs that machine; otherwise it stays on the agent's own, which has the same checkouts and tools.
  A part that runs elsewhere shows `@ <host>` on the card.
- `/super` is a skill the gateway links into each agent's skill directory, next to the `fleetherd`
  one. Claude Code offers it as a command; Codex, OpenCode and Antigravity pick it up from its
  description. The `gemini` and `dsh` harnesses get no skills from the gateway, so `/super` there
  says it is not supported.
- A sub-agent whose turn a gateway restart cuts off says so in its own topic; the agent that
  started it is not told.
