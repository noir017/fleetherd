# The dispatcher

English | [简体中文](zh-CN/dispatcher.md)

One person can only watch a few conversations at a time. Past three or four, the time goes to
checking which one is done, which one asked something, and which one failed, rather than to
the decisions only you can make. The dispatcher takes that over.

It is an agent of your choice that answers one pinned topic, **📥 Dispatcher**, in the
[web UI](web-ui.md). You tell it what you want done. It opens a topic for each piece of work,
gives it to an agent, and tells you in 📥 when one of them has a result, a question or a
failure. Topics that are fine are not mentioned.

```yaml
dispatcher:
  agent: claude-light        # any agents[].id except an agy agent

agents:
  - id: claude-light
    harness: claude
    model: claude-sonnet-5-5 # handing out work needs less than doing it
  - id: cc
    harness: claude
    cwd: ~/workspace
```

`talkcode reload` applies it (so does a restart). The 📥 topic appears at the top of the
sidebar.

## What it does

- **Hands out work.** "Have cc fix the failing test in talkcode" opens a new topic for `cc` in
  `talkcode` and sends it your words exactly as you wrote them. The message shows in that topic as
  **📥 From the dispatcher**. Several requests in one message become several topics.
- **Passes on follow-ups.** A message that clearly points at existing work ("tell the talkcode one
  to go ahead") goes to that topic. A message about a similar subject is treated as a new request.
- **Reports what needs you.** When a topic finishes with a reply you have not read, fails, or waits
  on a question, the dispatcher is told a few seconds later and writes one line in 📥, with a link
  that opens the topic. A topic you are already reading is not reported.
- **Stops work when you ask.** "Stop the quantlab one" stops that topic's turn. The conversation is
  kept.

You can still open any topic and talk to its agent directly. That does not go through the
dispatcher.

## What it cannot do

On a `claude` agent the dispatcher has no tools of its own: no shell, no file access, no web.
It only has the commands for handing out and following work. It cannot do the work itself, even
when asked. That limit is on purpose, because a dispatcher that can do the work tends to start
doing it.

Other ACP harnesses keep their own tools, and the gateway logs a warning. An `agy` agent cannot
be the dispatcher, because it cannot be given the task commands.

## Its instructions

The dispatcher reads its instructions from `~/.talkcode/dispatcher/AGENTS.md` on the machine it
runs on, and works in that directory. The file is written with defaults the first time and is
never overwritten after that. Edit it to change how the dispatcher picks agents or how short its
replies are. Changes apply from its next message.

The gateway also sends the dispatcher one kind of message of its own: a `[topic updates]` note
about the topics that need you. Before it is sent, it is shown in 📥 as a folded line, so you can
see exactly what the dispatcher was told.

## Notes

- `/cc`, `/agent` and `/cd` are refused in 📥. Its agent and directory come from the config.
  `/new` starts it over.
- The 📥 topic cannot be deleted or renamed, is never removed to make room, and survives
  **Clear**.
- Other platforms do not get a 📥 topic yet. The dispatcher still reports on topics there, in the
  web UI's 📥.
- Push notifications to your phone: see [Web UI → Notifications](web-ui.md#notifications).
