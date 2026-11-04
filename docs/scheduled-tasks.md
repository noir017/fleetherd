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
| **bash** | a command, run by the gateway itself — no agent | exit code, duration and the end of the output, long output attached |

Output can go to any chat the gateway has answered in, on any platform (`talkcode
channels` lists them). A run the gateway missed by less than an hour — it was restarting — is
made when it comes back; older is recorded as missed. Every change posts a card with the task's
details, written by the gateway rather than the agent, so what you read is what will run.

On the web UI, the clock at the right of the chat header opens a **⏰ Scheduled tasks** panel of
its own: the **Tasks** tab is the same list, plus "run now", and a pin that keeps it open beside
the chat. A task that runs in a new session opens a topic for each run; the **Sessions** tab lists
those topics, and they no longer appear in the ordinary topic list. `/setting` has a **⏰ Scheduled
tasks** button everywhere: every task with its next and last run, and pause, resume and delete
(delete asks twice). Where there are no buttons, `/setting schedule [pause|resume|delete|run <id>]`
does the same by typing.
