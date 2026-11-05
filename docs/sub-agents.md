# Sub-agents (`/super`)

English | [简体中文](zh-CN/sub-agents.md)

Some jobs split: two repositories to change, a fix and its review, three questions to look into.
`/super` lets the agent you are talking to split the job, hand the parts to other agents that work
in parallel, and come back with one report — so you follow one topic instead of four.

```
/super upgrade the API client in quantlab and quantlab-agents, and have cx review both
```

## What happens

1. The agent reads what it needs and splits the job. For each part it picks an agent — one on its
   own machine unless the part needs another — and writes the task that agent will get. It asks for
   a reply it can act on: the conclusion first, then the evidence, under 2,000 characters.
2. A card lists every part: the agent, its machine, the directory, and the full text of the task.
   **Nothing starts until you tap Start** — unless confirmation is off (`/setting delegation off`),
   in which case each part starts as it is proposed and the card is posted after it, listing what
   started and where, with no Start button. That applies only where you talk to the agent directly:
   in a sub-agent's own topic, `task-new` still puts up the card, so agents cannot open more agents
   without you. With confirmation on, to change something, write what instead of tapping, and it
   proposes again; the new card replaces the old one. A part that changes code is reviewed before
   it counts as done: once its change is in, the agent proposes a review part — another agent, the
   same checkout, told to read the diff and run the tests.
3. Each part gets a topic of its own, nested under this one, and they all run at once. The first
   message in each says which topic it came from.
4. When a sub-agent finishes, fails or asks something, the agent that started it is told. A folded
   🔔 line in its topic shows exactly what it was told. The notice quotes what the sub-agent said
   in full when it fits the card's budget — the reply, the question or the error, line breaks kept —
   so the agent can act on the conclusion without opening the topic. A cut adds one line with the
   text's full length and where the rest is: the card names the turn it quoted, and `task-read
   <topic> --turn <n>` reads that turn back — its reply with `--full`, a failed turn's whole error
   as the turn's record — because the ❌ notice in the topic carries only its opening. Reading by
   turn number, not "the last one", is what keeps a later background burst from taking its place. A
   burst longer than 20 sub-agents is one card with the rest folded into a line pointing at
   `talkcode tasks`. The agent reads each reply's conclusion and the review part's verdict, and
   sends fixes where needed; it does not read the diff itself. When every part is done, it writes
   one summary with a link to each topic.

## Talking to a sub-agent

A sub-agent's topic is an ordinary topic: open it, read it, write in it, `/stop` it. A turn you
start there is yours, so the agent that opened the topic is not told about it.

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
normally, its reply whole; `--full` raises the per-message cut and `--tail` keeps the newest lines,
so an hour-long turn is not a black box.

When a sub-agent is going the wrong way, `task-send --interrupt` stops the turn it is running and
sends the correction as the next one. Its conversation is kept: it carries on with the context it
already had. Without `--interrupt`, a message reaches a running turn only on harnesses that take
input mid-turn; elsewhere it waits for the turn to end, and the agent is told which happened.

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
- Any agent can propose sub-agents when you ask it to split work, without `/super`, and any
  configured agent can be one. The card waits for your tap by default.
- `/setting delegation off` (or `delegation.confirm: false`) starts each sub-task as the agent
  proposes it and posts the card afterwards as a record; `/setting delegation on` restores the tap.
  It reaches only conversations you talk to directly — a sub-agent's own topic still confirms.
  Only you can change it — no agent command reaches it.
- With agents on several [machines](remote-hosts.md), the agent prefers those on its own machine,
  which have the same checkouts and tools. A part that runs elsewhere shows `@ <host>` on the card.
- `/super` is a skill the gateway links into each agent's skill directory, next to the `talkcode`
  one. Claude Code offers it as a command; Codex, OpenCode and Antigravity pick it up from its
  description. The `gemini` and `dsh` harnesses get no skills from the gateway, so `/super` there
  says it is not supported.
- A sub-agent whose turn a gateway restart cuts off says so in its own topic; the agent that
  started it is not told.
