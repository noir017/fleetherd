# Scheduled tasks

English | [简体中文](zh-CN/scheduled-tasks.md)

Ask for it in plain words — *"every morning at 8, summarise the overnight CI failures"*,
*"in 30 minutes, run the backup and tell me how it went"* — and the agent registers a task the
gateway keeps. Tasks survive the agent's process being reclaimed and the daemon restarting,
which the harnesses' own schedulers do not.

| kind | what runs | where it answers |
|---|---|---|
| prompt, **fixed session** (default) | a turn in this conversation, by its agent — context accumulates, you can follow up in place | here, for **24 h** from registration; then it is marked expired |
| prompt, **new session** | a fresh session each run, by any agent | a new topic per run where the platform can open one (web UI, Telegram forums, Discord), else this chat; no time limit |
| prompt, **daily session** | one session per day: the first run opens it, later runs that day join it | its own topic per day, named with the date; needs a platform that can open one (web UI, Telegram forums, Discord); no time limit |
| **bash** | a command, run by the gateway itself — no agent | exit code, duration and the end of the output, long output attached |

Output can go to any chat the gateway has answered in, on any platform (`talkcode
channels` lists them). A run the gateway missed by less than an hour — it was restarting — is
made when it comes back; older is recorded as missed. Every change posts a card with the task's
details, written by the gateway rather than the agent, so what you read is what will run.

A daily task counts days in **its own time zone**, by each run's planned time: the first run of
2026-11-04 opens `⏰ name · 2026-11-04`, the rest of that day's runs reply into it, and the first
run of the 5th opens a new one. A run caught up after midnight still joins the day it was meant
for. Yesterday's topic is left as it is. The task remembers today's topic, so restarting the
gateway mid-day does not start a second conversation; if the topic is deleted, the next run opens
a new one. It cannot run where no topic can be opened — that is refused when the task is added,
and a run whose topic cannot be created fails and says so in the chat, rather than posting into a
conversation nobody can reply into.

A **new-session** or **daily** task can name the model its conversations use with `--model <id>`.
The id must be one the agent's own `/model` list offers: a name it does not offer is refused when
the task is registered, and the error lists what it does offer; a harness with no model selector
cannot take one at all. Each conversation the task opens starts on that model — in a daily task,
when the day's session opens — and a model the agent refuses fails that run with the reason, never
a silent fallback to another model. A **fixed-session** task runs in your own conversation and
keeps that conversation's model (set it with `/model` there), so `--model` is refused for it. In a
daily topic, a `/model` you type during the day wins over the task's choice for the rest of that
day.

On the web UI, the clock at the right of the chat header opens a **⏰ Scheduled tasks** panel of
its own: the **Tasks** tab is the same list, plus "run now", and a pin that keeps it open beside
the chat. A task that runs in a new or daily session opens topics; the **Sessions** tab lists
those topics, and they no longer appear in the ordinary topic list. `/setting` has a **⏰ Scheduled
tasks** button everywhere: every task with its next and last run, and pause, resume and delete
(delete asks twice). Where there are no buttons, `/setting schedule [pause|resume|delete|run <id>]`
does the same by typing.
