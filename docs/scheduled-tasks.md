# Scheduled tasks

English | [简体中文](zh-CN/scheduled-tasks.md)

Ask for it in plain words — *"every morning at 8, summarise the overnight CI failures"*,
*"in 30 minutes, run the backup and tell me how it went"* — and the agent registers a task the
gateway keeps. Tasks survive the agent's process being reclaimed and the daemon restarting,
which the harnesses' own schedulers do not.

| kind | what runs | where it answers |
|---|---|---|
| prompt, **fixed session** (default) | a turn in this conversation, by its agent — context accumulates, you can follow up in place | here, for **24 h** from registration; then it is marked expired |
| prompt, **new session** | a fresh session each run, by any agent | a new topic per run where the platform can open one without a message (the web UI, a Telegram forum group), else this chat; no time limit |
| prompt, **daily session** | one session per day: the first run opens it, later runs that day join it | its own topic per day, named with the date; needs a platform that can open a topic without a message (the web UI, a Telegram forum group); no time limit |
| **bash** | a command, run by the gateway itself — no agent | exit code, duration and the end of the output, long output attached |

Output can go to any chat the gateway has answered in, on any platform (`fleetherd
channels` lists them). A run the gateway missed by less than an hour — it was restarting — is
made when it comes back; older is recorded as missed. Every change posts a card with the task's
details, written by the gateway rather than the agent, so what you read is what will run — in the
conversation the change was made in and in the one the task posts to, with the prompt quoted in
full rather than cut at the first 200 characters.

A run that does not deliver says so in the conversation it posts to, as one line:
`⏰ #id name failed at 09:26 — reason`. That covers a turn that ended failed (which used to leave
the start notice as the only message), a run skipped because the previous one of the same task was
still going, and one missed because the gateway was down. The same reason twice in a row is
reported once, so a task that keeps failing does not fill the chat. `schedule show <id>` prints the
last 20 runs — when each ran, how it ended, how long it took, and the topic its output went to —
so "how did the last few days go" is one command, not a reading of the conversation library per
day. Missed and skipped runs are in that list too.

A daily task counts days in **its own time zone**, by each run's planned time: the first run of
2026-11-04 opens `⏰ name · 2026-11-04`, the rest of that day's runs reply into it, and the first
run of the 5th opens a new one. A run caught up after midnight still joins the day it was meant
for. Yesterday's topic is left as it is. The task remembers today's topic, so restarting the
gateway mid-day does not start a second conversation; if the topic is deleted, the next run opens
a new one — a platform that cannot say whether it still exists is caught when posting into it
fails, which clears the record. It cannot run where no topic can be opened: a target whose
platform cannot open one without a message is refused when the task is added. Telegram is the one
case that is knowable only at run time — only a forum supergroup has topics — so a run in an
ordinary group fails and says why, and consecutive runs failing the same way report it once
instead of on every run. A create that fails — or a topic that comes back empty — fails that run
and says so in the chat, rather than posting into a conversation nobody can reply into.

A **new-session** or **daily** task can name the model its conversations use with `--model <id>`.
The id must be one the agent's own `/model` list offers: a name it does not offer is refused when
the task is registered, and the error lists what it does offer; a harness with no model selector
cannot take one at all. Each conversation the task opens starts on that model — in a daily task,
when the day's session opens — and a model the agent refuses fails that run with the reason, never
a silent fallback to another model. A **fixed-session** task runs in your own conversation and
keeps that conversation's model (set it with `/model` there), so `--model` is refused for it. In a
daily topic, a `/model` you type during the day wins over the task's choice for the rest of that
day, including after the gateway restarts: the task records that the topic was set by hand and
stops applying its own model.

Change a task in place with `fleetherd schedule edit <id>` and any option `add` takes: `--agent`,
`--cwd`, `--host`, `--model`, `--cron` / `--at` / `--tz`, `--name`, `--tag`, `--prompt` or `--bash`,
`--timeout`, `--session` and `--channel`. A long prompt is best passed through your own shell —
`--prompt "$(cat prompt.md)"` — so the file is read on the machine you type the command on, not by
the gateway. What a task *is* can change too: `--prompt` turns a bash task into a prompt task (a
fixed session unless `--session` says otherwise, as with `add`), `--bash` turns a prompt task into a
command, `--session` changes the mode, and `--channel` moves where it posts. The id, the tags, the
run count, the run history and the last result stay whatever changed — the history still says what
each earlier run did and where — and the next run is computed from the edit under the new time
rule: a task edited to a time that already passed today waits for tomorrow instead of firing at
once. Anything you do not give stays, where the task's new shape has a place for it: a task turned
into a fixed session leaves its own directory and model behind (its topic's apply), one turned into
a command leaves its agent and model, and one turned into a prompt task leaves its timeout. A
fixed-session task keeps its 24-hour window while it stays in the same conversation; one that
becomes a fixed session — from another mode, or moved to another conversation — gets 24 hours from
the edit, as a new one would. A moved task's card is posted where it posted before as well as where
it posts now. A daily task whose agent, directory or target changes cannot go on in the topic it
already opened today — a topic keeps its agent and its directory — so the next run opens a new topic
for the rest of the day, and the earlier one is left as it is.

`fleetherd schedule run <id>` runs a task once, now, without touching its schedule. With
`--wait` it answers when the run has ended, with the status, exit code and duration, instead of
leaving you (or an agent) to poll: `--wait 30m` waits that long, and bare `--wait` ten minutes.
When the wait runs out the answer says the run is still going; it finishes and posts its output as
any other run does. A wait is at most an hour and at least a second.

Label a task with `--tag ci,release` when it is registered, or with `fleetherd schedule edit <id>
--tag …` later: up to five tags, each at most 24 characters, lowercased, made of letters (Chinese
included), digits and `- _ . /`. `edit` replaces the whole set, and `--tag ""` clears it. The tags
are shown under the task's name and on the card posted for the change; the web UI's Tasks list
filters by them.

A task's directory is a path on one machine, and the task has to run on that machine. A `--cwd` is
a path on the machine you type the command on, and without one `add` takes your conversation's
directory. So when the task runs on another machine — an agent on a [remote host](remote-hosts.md)
— the command is refused rather than storing a directory that means something else there: an `add`
for that agent, an edit giving it a `--cwd`, and an edit moving a task to it with `--agent` while
the task keeps a directory from the old machine. `--host <id>` is the way through: it says the
`--cwd` you are giving belongs to that machine, and that path must be absolute — a relative one or
`~` would be resolved here, on the wrong machine — and the gateway checks it exists there before
storing anything; with no `--cwd` at all, `--host` makes the task start in that machine's own
default directory instead of this conversation's. Without `--host`, a `--cwd` is still read as this
machine's — run the command from a conversation on that machine if you would rather do it there
(moving a task, add a `--cwd` there). A task with no directory is not affected. A bash task runs on
the machine of the agent that registered it, where its directory came from, unless `--host` names
another — for a bash task `--host` is the machine that runs the command, on `add` and on `edit`.
`--host gateway` is the gateway's own machine, so `edit <id> --host gateway --cwd /srv/app` brings a
command back from a remote host.

On the web UI, the clock at the right of the chat header opens the **⏰ Side tasks** panel of its
own: the bottom has **Scheduled** and **Reviews** tabs. Under **Scheduled**, the **Tasks** sub-tab
is the same list, plus "run now", a search field, filters and a sort. The search matches the task's
name, its prompt or command, and its target. **Filter** narrows by **Status** — Running, Active,
Paused, and Ended (expired and done together) — and by **Tags**, which offers every tag in use plus
**Untagged**. The sort is Status (the default, the list's own order), Next run, Last run or Created,
ascending or descending; a task with no next run, or one that has never run, stays at the bottom
either way. The keyword, filters and sort are kept in this browser. A task is a row like a topic's:
its ⋯ holds Pause or Resume, Run now, Edit and Delete. Only the Tasks sub-tab has this bar —
Sessions and Reviews do not — and the **+** in the panel's head, which adds a task.

A tap on a task opens **its page**: the schedule and the next run, how it runs (agent, model,
session), its directory, where it posts, the whole prompt or command, and the same actions as
buttons. The tags are edited there — the × removes one, and typing in **+ tag** and pressing Enter
adds one. Below are its **Sessions**, the topics its runs opened that the web UI still has, and its
**Runs**, the last twenty with how each ended, how long it took, and an **Open** for the topic it
posted into. A tap on a session or an Open goes to that topic.

**+** opens an empty form for a new task, and **Edit** — on the page, or in the row's ⋯ — the same
form filled from the task. It holds everything `schedule add` takes: what it runs (an agent prompt
or a bash command), the session (a new topic each run, one topic a day, or a turn in the topic it
posts to), the agent and the model, the machine a command runs on (the gateway's, or a [remote
host](remote-hosts.md)), the directory, a command's timeout, the time (a cron, or one run at a date
and time) and its zone, where it posts, and the tags. **Posts to** lists the web UI's topics by name;
**Another chat…** takes any id `fleetherd channels` prints, so a task can post to Telegram or any
other chat the gateway has answered in. The form shows only the fields the kind and session you pick
have a place for: a fixed session has no directory or model of its own (they are its topic's,
changed with `/cd` and `/model` there), a daily task takes only a cron, and a command has no agent.
A new task starts on a new session, the gateway's time zone and agent, and the topic you are in.
Saving checks it by the same rules as `schedule add` or `schedule edit`, so a refusal says what the
CLI would, and an edit sends only what you changed. An empty model or directory goes back to the
agent's own. A directory is a path on the machine the task runs on and must be absolute; it is
checked there before anything is stored. The conversation the task posts to gets the card, and a
task moved elsewhere also tells the conversation it left. A task that is running cannot be edited
until the run ends, and one that has expired or had its one run cannot be edited at all. Closing a
form with changes asks first. On a phone the same panel is a drawer from the right, with the chat
still visible behind it and a tap on the dimmed area to close it. A task that runs in a new or daily
session opens topics; the **Sessions** sub-tab lists those topics, with any sub-agents a run opened
nested under it, and none of them appear in the ordinary topic list. The panel's second outer tab, **Reviews**, is the automatic review of quiet
conversations — see [skills](skills.md#auto-review) — not scheduled work, and shares the panel only
because both are background jobs with no conversation of their own.
`/setting` has a **⏰ Scheduled tasks** button everywhere: every task with its
next and last run, and pause, resume and delete (delete asks twice). Where there are no buttons,
`/setting schedule [pause|resume|delete|run <id>]` does the same by typing.

