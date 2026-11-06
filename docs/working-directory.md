# Working directory (`/cd`)

English | [简体中文](zh-CN/working-directory.md)

`agents[].cwd` says which directory an agent starts in. `/cd` says which
directory *this conversation* works in, so one topic can be about one project and
the next about another without touching config.yaml.

The list is the agent's own `cwd` plus the directories one level inside it — no
second place to declare projects, and a new one appears in the menu by existing
on disk. The root is always offered, so a conversation can get back out.

```
/cd                →  a button menu of the projects under the root
/cd quantlab       →  move there by substring, on every platform
```

The menu leads with the directories you actually use — a project's rank is how
often it has been chosen, with each past choice discounted by how long ago it was
(a fortnight half-life). A plain counter would leave last quarter's project on
top forever; a plain "most recent" would let one curious click displace the
project you have lived in all month. Anything never chosen keeps its alphabetical
place, and the root stays first as the way back out. This is remembered per
machine, not per conversation, so a brand-new topic gets the benefit of it
immediately.

A page holds as many directories as the platform can carry — twelve on Telegram,
Discord and Slack, which is one page for a typical workspace, and 24 in the web UI,
which lays the menu out as a grid — so choosing is usually a tap rather than a page
turn.

You are asked the question at the two moments it is free: a bare agent command
(`/cc`, `/oc`, `/agy`) in a conversation that has never run, and right after
`/new`. An **ongoing** conversation is never interrupted with it — including one
whose agent process was reclaimed while idle, which resumes where it left off.

Moving **starts a fresh session** in the new directory, and the menu says so
before you tap. That is not a policy choice: a session is pinned to the directory
it was created in (ACP takes `cwd` at `session/new`), so the move
cannot reach a process that is already running. Tapping the directory you are
already in (marked ●) costs nothing. The choice is recorded per conversation, so
it survives a restart and a `/new`, and applies to every agent that answers there.
