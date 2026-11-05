# `src/daemon/` — the running system

The only module allowed to depend on every other one. It owns routing, conversation
lifetime, turn orchestration, and the agent runtimes.

Vocabulary, since the two used to be one word and that is much of why this went wrong:
a **conversation** is the IM-side unit (a topic, a thread, a channel — see
[`core/conversation.ts`](../core/README.md)); a **session** is the agent-side one (an ACP
session id, agy's conversation id). One conversation holds one session *per agent*.

## Files

| File | Role |
|---|---|
| `daemon.ts` | Top-level wiring: platforms + conversation registry + IPC. Slash registration, `ask` buttons, harness pickers, the `/model`, `/cd` and `/setting` menus. |
| `routing.ts` | Pure: inbound → which agent (and whether the user *asked* for it) + which scope |
| `conversation.ts` | `ConversationRegistry` — per-conversation state, agent binding, access + gating, command translation |
| `settings-store.ts` | The write half of `/setting`: validate, patch config.yaml, apply to the live `Config` |
| `model-catalog.ts` | Any agent's model list for the settings screen: from a live session, from what was learned, or from a session brought up just to ask |
| `config-reload.ts` | `/reload` and `talkcode reload`: diff the re-read config against the live one, copy it in place, and say what changed. Which sections apply live and which need a restart is decided in its `RELOAD_KIND`; what happens to running agent processes is `ConversationRegistry.respawnAgents` |
| `turn-runner.ts` | One turn end to end: prompt, streaming, tools, footer, errors |
| `paced-adapter.ts` | Wraps every `PlatformAdapter` in the shared per-chat write budget |
| `agent.ts` | `AgentFactory` / `AgentSession` / `AgentStreamHandlers` interfaces. Dependency-free. |
| `agent-factory.ts` | Dispatch: which runtime serves which agent |
| `agent-acp.ts` | ACP runtime (claude, codex, opencode, gemini, custom). Also answers `session/request_permission`: approve under `permissions: auto`, ask through the turn's (or a background burst's) `onPermission` under `ask` — see answerPermission / permissionResponse for why an unanswered request goes back as an error |
| `session-failure.ts` | claude-agent-acp's typed failure records: the capability that asks for them, and reading one off the wire |
| `acp-steering.ts` | How an ACP harness takes a message into a running turn (a second prompt, `_session/steering`, or not at all), read off `initialize` |
| `agent-agy.ts` | Antigravity CLI runtime — its own stream-json protocol |
| `agy-meters.ts` | Where agy 1.4.7+ reports context, model and quota, now that `-p` runs no status line: per-step stream `usage`, a measured window table, and the `/model` / `/usage` one-shots |
| `agy-statusline.ts` | How an agy older than 1.4.7 reports the same three: a shim installed into its `statusLine` setting, reporting back over fd 3. Still installed, for that and for the operator's own TUI |
| `status-board.ts` | Each conversation's live agent status, pushed (deduped, throttled) to a platform that can show one — the web UI's strip |
| `claude-transcript.ts` | claude's prompt-cache expiry, read off Claude Code's own transcript (headless Claude Code runs no status line) |
| `agent-common.ts` | Protocol-agnostic helpers shared by both runtimes |
| `agent-hooks.ts` | The operator's `agents[].hooks`: `preLaunch`, run to completion before every spawn of an agent's child, by both runtimes |
| `conversation-store.ts` | Persisted per conversation: the bound agent, each agent's own session id, and the directory it works in |
| `workdir-scan.ts` | The `/cd` option list: an agent's configured root plus the projects one level inside it |
| `workdir-usage.ts` | How often each directory has been chosen with `/cd`, so the menu leads with the ones in use |
| `skills-scan.ts` | The `/skills` list: where each harness keeps its installed skills, read off disk |
| `conversation-token-registry.ts` | Per-conversation reverse-command token ↔ conversation id |
| `attachment-io.ts` | Real attachment IO + the SSRF guards |
| `voice.ts` | Voice messages: download, transcribe (Gemini `generateContent`), the Send/Cancel card, re-entry as text, `voice-log.jsonl` |
| `scheduler.ts` | Scheduled tasks' timing: one re-armed timer, what is due, the bookkeeping that keeps a restart from repeating or losing a run |
| `schedule-store.ts` | `<configDir>/schedules.json`: 0600, atomic writes, a bad entry dropped loudly |
| `schedule-service.ts` | Scheduled tasks wired to the rest: a run as a bash process or a turn, the agent's `schedule` commands, the cards |
| `schedule-bash.ts` | One `--bash` run: its own process group, a bounded output tail, the full log on disk. Also runs `preLaunch` hooks |
| `restart-drain.ts` | A SIGTERM with turns or scheduled runs in progress: the bounded wait for them before the daemon stops (`Daemon.beginDrain` refuses new turns and holds the scheduler meanwhile) |
| `reverse-cli-shim.ts` | Guarantees `talkcode` is on the agent's PATH; `selfInvocation` — how to re-run this CLI, shared with the tool server entry |
| `skill-link.ts` | Links the bundled skills (`talkcode`, `super`) into the skill directories the harnesses read (`~/.claude/skills`, `~/.agents/skills`, `~/.gemini/config/skills`) |
| `instructions.ts` | The operator's instructions (`<configDir>/instructions/`: `common.md` + one file per kind of agent), composed and linked into each harness's own user-level instruction file (`~/.codex/AGENTS.md` …) — the per-harness evidence is in its header |
| `skills-store.ts` | The gateway's own skills (`<configDir>/skills/`): names, paths and size rules, content versions, `.usage.json`, `.archive/`, and `.history/` with `revert` |
| `skills-panel.ts` | The web UI's skills page: store records → the page's shape, every operation forwarded to `skills-store.ts`, and the archive notice the reverse command sends |
| `skill-usage.ts` | What counts as using a managed skill — a `Skill` tool call, `/<name>`, a file under its directory — once per turn, with `talkcode skills` excluded |
| `skill-lifecycle.ts` | The daily check (14 days expired, 30 archived, pinned exempt) and its archive notice |
| `managed-skills.ts` | Delivering active skills to `~/.talkcode/skills/` on an agent's machine and linking only links that point back there; taking an archived skill's links back |
| `harness-log.ts` | Reading a harness's own log for the reason a silent turn failed (opencode's rate-limit retries), during the turn and on timeout — see [TurnRunner](#turnrunner) |
| `turn-outcomes.ts` | What each turn left for the person (pushed to a platform that lists conversations), `hooks.turnFailed` (automatic continue, the alert command), and turns a restart cut off — see [What needs the person](#what-needs-the-person-outcomes-and-sub-agents) |
| `delegation.ts` | Sub-agents: the six task commands (acting only on the topics the asking conversation opened), the confirmation card every start waits on by default (or the record card when it is off), and the `[sub-agent updates]` card |
| `remote-hosts.ts` | The `hosts:` table: one `RemoteHost` (src/remote/) per entry, shared by its agents; this gateway's namespace; running an agent's `talkcode …` back here (the allowlisted bridge); placing the skill on a host |
| `pods.ts` | What each host's pod declares: its `~/.talkcode/pod.yaml`, or the harness commands on its login PATH when it has none. Read at startup and on every `/reload` (`Daemon.reloadAll`) into `pods.json`, which `config/pods.ts` merges into `agents` as `<id>@<host>`. A host that cannot be read, or whose file does not validate, keeps what it had |
| `pod-admin.ts` | `talkcode pod-add` / `pod-remove`: a `hosts:` entry in config.yaml and its pinned host key, changed together and refused before anything is written when either would end up wrong; and the authorized_keys line `talkcode pods` offers a new host |
| `pod-peers.ts` | The pod-to-pod ssh mesh (`peer:` in pod.yaml): the `authorized_keys`, `known_hosts` and `config` it writes into each member's `~/.talkcode/ssh/` after every read of the pods. Host keys come from the gateway's own known_hosts, never the network |
| `host-probe.ts` | The `command -v` script run on a host in the PATH an agent will have: `talkcode doctor`'s check of each host, and `pods.ts`'s look at a host with no `pod.yaml` |
| `agent-renames.ts` | `agent-renames.json`: new ids for agents, applied at startup to config.yaml, `conversations.json` and `schedules.json` together (after backing them up), because an id is also the key each conversation and task remembers its agent by |

## Inbound flow

```
adapter.onMessage
   │
   ▼
Daemon.onInbound ─── cross-event dedup (platform:address:message, 15 s TTL)
   │
   ▼
ConversationRegistry.route
   ├─ access gate        access.allowFrom — `platform:userId`
   ├─ conversationKey    scope + the message's ConversationRef → the conversation id
   ├─ resolveAgent       routing.pipeline, then HARNESS_COMMANDS → { agentId, explicit }
   ├─ response gate      core/inbound-gate shouldRespond
   ├─ /new · /clear      reset the conversation, drop every agent's id, ack. Never forwarded.
   ├─ /stop              cancel the running turn and the queued backlog — or, with no turn, a burst
   │                     of background output (AgentSession.stopBackground) — ack. Never forwarded.
   ├─ /kill              /stop, then end the agent child; the session id is kept. Never forwarded.
   ├─ /help              the registered vocabulary, from core/command-translate. Never forwarded.
   ├─ unconfigured agent `/agy` with no agy agent → say so, run no turn. Never forwarded.
   ├─ agent switch lock  explicit `/oc` in a topic whose agent has a session → refuse, hand over its id
   ├─ bind or rebind     new conversation → bind; explicit `/oc` with no session yet → rebind; else keep
   ├─ bare command       `/oc` alone → its command menu, or a binding ack if it reports none
   ├─ voice message      audio and nothing else → VoiceIntake: transcribe, card, and — on ✅ Send —
   │                     back into route() as typed text. Nothing reaches the merger until then.
   ├─ command translate  generic → native, or refuse
   ├─ header bubble      once per conversation, on receipt
   ├─ supersede          a typed message drops any transcript still waiting here
   ▼
InboundMerger.ingest ── merge window; mid-turn: TurnRunner.steer, else queue
   ▼
TurnRunner.runTurn
```

Several orderings in `route()` are load-bearing and commented in place:

- **`hasActiveSession` is read before any merger is built** — otherwise it is always
  true once a conversation exists and the thread-participation exemption is distorted.
- **Gating runs on the original content**, not the prefix-stripped one. A bare `/oc`
  strips to empty and would trip the empty-message gate, losing the usage ack. The gate
  rejects messages that *arrived* empty (a native slash command's phantom message), not
  ones `route` just emptied.
- **Command translation sits after binding**: it is the first point that knows *which*
  agent will answer, and the last point at which the message can still be refused.
- **The header is sent after every gate**, so it cannot become a probe — a message that
  will not be answered gets no acknowledgement of any kind.
- **`/new` is intercepted before the merger**, so it works mid-turn (dispose aborts the
  in-flight turn). `/stop` sits beside it for the same reason: a stop command that only
  worked between turns would be useless exactly when it is wanted. `/kill` too, and more so —
  the turn it is for is one `/stop` could not end.
- **The unconfigured-harness check runs before binding**, and only on a name `resolveAgent`
  declined — so a `when.command` rule or a configured harness always wins, and a name nobody
  claimed never binds a conversation on its way to being refused.

## Voice messages

A message that is audio and nothing else — a Telegram or Feishu voice note, a web UI recording,
an audio file sent without a caption — is taken by `VoiceIntake` (`voice.ts`) when config has a
`voice:` block. The decisions (what counts, which formats, the prompt, the card's wording, the log
fold) are pure and live in [`core/voice.ts`](../core/README.md); this file does the IO.

```
route() ──take()──► download (attachment-io: SSRF guard, platform fetcher)
                    → sniff the container, save the file
                    → transcribe: <baseUrl>/models/<model>:generateContent  (audio → words as heard)
                    → cleanup (voice.cleanup): the same endpoint again, text only (words → message meant)
                    → card: "🎙️ Voice transcript · <model> · <s>" + cleaned-up, then as spoken
                          + [✅ Send] [🗣️ Send as spoken] [✖ Cancel]
                          (confirm: false, or no buttons on this platform → posted as sent, at once)
          ✅ Send ──► route(msg with the cleaned-up text — or the transcript, when there is none —
                          as content, no attachments, same messageId, { transcript: true })
```

Why it is shaped this way, one line each:

- **Taken before the merger.** The merger hands a mid-turn message straight to the running turn;
  a recording nobody has approved must not reach the agent. It does when the transcript is sent,
  like any typed message.
- **Re-enters through `route()`**, not `dispatchTo`, so a transcript is answered exactly as typed
  text: it can answer a question the agent is waiting on, and `/stop` said aloud is a `/stop`.
  `{ transcript: true }` stops it being offered for transcription again and stops it superseding
  the *other* transcripts waiting (confirming one of two voice notes must not drop the second).
- **The message id is kept**, so the 👀/✅ reactions land on the voice note.
- **Typing supersedes.** The card says to type a corrected version instead of tapping, and a typed
  message reaching the agent retires every transcript still waiting in that conversation —
  including one still being transcribed, whose card then arrives already marked.
- **`/stop` and `/new` call transcripts off**, pending or in flight; `/stop` says so when that was
  all there was.
- **Serialized per conversation**, so two notes sent back to back reach the agent in order even
  when the second transcribes faster.
- **`confirm` is read when the transcript is ready**, not when the job starts — `/setting voice` is
  live, and applies to a note already being transcribed.
- **The cleanup never hears the audio.** It is a second, text-only request given the transcript.
  Asking for both versions in the one audio request was tried first, and on a three-second
  recording the verbatim prompt answers with `[no speech]` it invented a whole request as both
  versions (see `cleanupInstructions` in core/voice.ts). A cleanup that fails leaves the transcript
  standing and the card says why; it never fails the voice note.
- **Two deadlines.** `transcriber.timeoutMs` bounds the whole transcription, cleanup included; each
  attempt has its own shorter one and is retried when it stalls, because the upstream's latency is erratic rather
  than slow (the same six-second note took 1.3 s and 65 s on 2026-09-25). A 400 that refuses the
  thinking config is retried once without it — `gemini-3-flash` behind newapi is an alias for 3.6 on
  some channels and 3.7 on others, and they accept different thinking levels. So is a 200 with an
  empty answer or `blockReason: OTHER`: both came back from requests that answered properly
  moments later (2026-10-17), and an empty answer used to be read as "no speech".

Every step is logged: `[voice]` lines in daemon.log, and one JSON event per fact in
`<configDir>/voice-log.jsonl` (0600, rotated to `.1` past 5 MB) — the transcript and its
cleaned-up version (or why there is none) with the audio path, model, latency and token counts,
then its outcome. The agent reads its own conversation's
entries with `talkcode voice-log`; nothing in its prompt says a message was spoken.

## Routing, binding, and conversation keys

`routing.ts` answers two questions with **different lifetimes**, which is why it is two
functions rather than one:

- `resolveScope` — how a conversation is identified. A property of config.
- `resolveAgent` — `{ agentId, explicit }`. Config chooses a conversation's *initial*
  agent; after that the user does.

Both walk `routing.pipeline` in order; the first rule whose `when` **fully** matches
wins, else `routing.default`. Match fields: `platform` (instance id), `serverId`,
`channelId` (matches the channel, ignoring any lane), `userId`, `chat`
(private/group/thread), `isBot`, `command`.

`when.command` matches the leading `/name` of **plain message text**, so command routing
works on every platform regardless of native slash support — `Daemon.onCommand`
synthesizes native invocations into a full inbound message, so one code path covers both.

**Agent commands resolve without a rule.** When no pipeline rule matched on `command`,
`resolveAgent` falls back to `HARNESS_COMMANDS` (`/cc`, `/oc`, `/agy` — see
[`core/command-translate.ts`](../core/README.md)) and selects the first configured agent
of that harness. Those names are what gets registered in the platform menu, so without
this a fresh install advertised commands the daemon did not recognise and forwarded them
to the bound agent as literal text. Precedence:

1. a pipeline rule that matched on `when.command` — hand-wired, so it wins (and can point
   `/cc` at a *second* claude agent, or keep an alias the presets know nothing about);
2. a built-in agent command;
3. whatever rule matched on where the message came from — the initial binding;
4. `routing.default`.

Step 2 sits above step 3 because naming an agent is an instruction, while a rule matching
on platform or channel only supplies that conversation's default answerer.

**`explicit` is the hinge.** It is true when the user *named* the agent — via a
`when.command` rule or a built-in agent command. The registry then:

| situation | what happens |
|---|---|
| conversation is new | bind the resolved agent (or the one the store remembers, after a restart) |
| existing + explicit `/oc`, bound agent has **no** session id yet | **rebind** — this is still choosing: nothing to strand |
| existing + explicit `/oc`, bound agent **has** a session id | **refuse** (`refuseAgentSwitch`): no turn, no rebind; the reply carries the bound agent's session id and directory |
| existing + not explicit | **use the bound agent** — the fix for the reported bug |

**A topic keeps its agent** (2026-09-30). Switching in place used to be supported, and was
unused: none of the 335 conversations on the live deployment had ever held two agents'
sessions. What it cost was a topic whose `[cc]` tag, header and history described one agent
while another answered it blind. So a topic whose agent has a session is locked to it, and
the refusal is written as a handover — the session id and working directory are exactly what
another agent, in a new topic, needs to read the earlier conversation off disk. `/new` (and
`/cd`, which also drops the ids) empties a topic, after which naming any agent is choosing
again. The check reads the **store**, not in-memory state, so the first message after a
restart is held to the same rule. It sits after the daemon commands, so `/oc /new` still
clears, and before the pending-question check, so `/oc …` is never filed as an answer.

A non-command rule deliberately does *not* rebind an existing conversation: re-applying
it on every message would make the binding impossible to change, and stickiness
meaningless. The `/name` prefix is consumed, so the target agent never sees it.

Conversation keys carry **no agent id**:

```
shared       → shared
per_user     → <platform>#u#<userId>
per_channel  → <platform>#<channel>
per_thread   → <platform>#<channel>#<thread|>      (default)
```

That absence is the whole point. When the agent led the key, `/oc hi` and the plain
message after it were two different conversations in one topic — the second silently fell
back to `routing.default` with empty context. Under `per_thread` the lane component is
present but empty for a channel root, so a root and a topic can never collide.

## Conversation lifetime

**A conversation lives for the daemon's lifetime; its agent process does not.** The
conversation ends only when the daemon stops or the user sends `/new`. The resident
harness child under it is reclaimed after `session.idleTimeoutMs` of silence — see
[Idle reclaim](#idle-reclaim) below.

`ConversationState` is one object per conversation (previously parallel `Map`s). Creation
sets it in one assignment (no half-init), release is one `delete` (no leak), and adding a
field touches only that interface. The stable token is the exception — it lives in
`SessionTokenRegistry`, since token bookkeeping is a separate concern from turn
orchestration.

### The agent owns its context

**The IM side is a client. It must never make an agent restart a task.** That rule
decides the store's shape: `ConversationStore` (`<configDir>/conversations.json`) holds,
per conversation, the bound agent *and* a map of `agentId → that agent's own session id`.

Keying sessions by `(conversation, agent)` is what stops claude from ever being handed
opencode's session id — and what once made `/oc` → `/cc` → `/oc` *resume* opencode's thread,
before topics stopped switching agents (above). The harness keeps the actual history on its own disk; this only
remembers *which* of its sessions belongs where, so a restarted daemon can `session/load`
it (ACP) or pass `--conversation` (agy) rather than starting blank.

A missing or corrupt file degrades to empty (bindings lost, agent histories untouched).
`/stop` is the narrow sibling of `/new` and touches none of this: it cancels the running
turn and drops the queued backlog through `InboundMerger.interrupt()`, leaving the
context, the session ids, the binding and the child process exactly as they were. It
deliberately does not reach the agent through `agents.getOrCreate` — building a session
for a conversation that has none, in order to stop it, is backwards; the abort travels via
the merger, which only fires it in the `running` phase where a session must exist.

When the merger is idle, `/stop` asks the existing session (`agents.peek`, same reason) to
`stopBackground()`: the harness may be reporting on background work with no turn open, which
the merger cannot see — see [Out-of-turn output](#out-of-turn-output-becomes-a-follow-up-message).
That answers `⏹ Stopped the background work`; only when neither has anything is it
"Nothing is running here."

`/kill` sits between the two. It ends the agent child and keeps everything else — the idle
sweeper's reclaim, asked for by name, and the only way out of a harness wedged in a tool call,
since `/stop`'s `session/cancel` is cooperative and a wedged harness never answers it.
`killConversation` is order-sensitive: it asks the session's `reclaimState` first and refuses
outright on `unresumable` (ending that child would restart the conversation, which is `/new`);
then it calls off pending asks, interrupts the merger, and only then disposes the session — never
the factory's handle, so the runtime `/model` choice survives. Disposing without the interrupt
would let the merger mark the dead turn ✅ and start the queued backlog, respawning the child a
moment after the ack said it was gone. Unlike `reclaimAfterAskTimeout` it does not wait for the
turn to unwind; a turn that never unwinds is the case it exists for.

`/new` is the single context-destroying path in the system, and it clears **every**
agent's id for that conversation: the topic *is* the conversation, so a reset that let
another agent's history resurface on the next `/oc` would be a surprise rather than a
reset. A pre-0.3 `sessions.json` is migrated on first start (`migrateLegacySessions`), so
in-flight work survives the upgrade.

### What `/cd` offers, and in what order

The candidate list is derived, never configured: `workdir-scan.ts` reads `agents[].cwd`
and the directories one level inside it, so a new project appears in the menu by existing
on disk. One level, because recursing turns a menu into a file browser; the root is always
the first option, so a conversation that wandered into a project can get back out.

The ORDER comes from `workdir-usage.ts` (`<configDir>/workdir-usage.json`) — two numbers
per absolute path, ranked by [`core/frecency.ts`](../core/README.md). It is a separate file
from `conversations.json` for a reason that is easy to get backwards: how often a directory
is used is a fact about the **machine**, not about one topic, so a brand-new conversation
should get the benefit of it on its very first menu. (And `conversations.json` is literally
a map of conversation key → record, validated entry by entry, so a usage table at its top
level would be read back as one more malformed conversation and dropped.)

A use is counted where a move actually happened — `setWorkdir` returning `applied`. Not on
`unchanged`, because re-picking the directory already in use is how a user dismisses the
menu (it is the one marked ●), and not on `missing`, because a directory that turned out
not to exist should not earn a place in the ranking. With no usage file, the list is the
scan's alphabetical order, which is what it was before any of this existed.

### Auto-thread adoption

When `autoThread: perTurn` opens a thread mid-turn, the reply moves into it — so the
user's next message arrives from a place that would otherwise key as a *new* conversation,
and the agent would answer its own follow-up from scratch. `TurnRunner` calls
`deps.adoptThread`, and the registry aliases the thread's key to the conversation that
opened it. The alias is in-memory only: after a restart such a thread becomes its own
conversation, which is a self-correcting degradation, unlike discarding context.

### Idle reclaim

`scope: per_thread` means every topic anyone has ever messaged holds its own resident
harness child, and a Claude Code process is hundreds of MB. So after
`session.idleTimeoutMs` (user-facing, default 1 h, `0` disables) the registry's sweeper
stops the child of a conversation nothing is happening in.

**Reclaim is the restart path, applied one conversation at a time.** A daemon restart
already kills every child and resumes each conversation from the session id in
`conversations.json` — ACP `session/load`, agy `--conversation`. This does that to one
idle conversation deliberately, to get its memory back. Nothing that identifies the
conversation is touched: state, binding, reverse-command token and stored session ids all
stay, and `AgentSession.dispose()` is called rather than `AgentFactory.dispose()` so the
session HANDLE survives too — which is what keeps the conversation's runtime `/model`
choice across the respawn. The only thing a user can perceive is that the next message
waits a few seconds for the child to come back.

That earlier paragraph in this file claiming reclaim would "silently drop the agent's
context" predates `conversations.json`. It was true when the daemon held the only copy of
which session belonged where.

Four conditions, each protecting against a different way of being wrong:

| gate | what it prevents |
|---|---|
| quiet longer than the deadline | — |
| `merger.isIdle()` | killing work in flight. The clock starts when the last turn ENDED (the merger's `onIdle`), so a task that runs for hours — subagents included — is never a candidate while it runs |
| `hooks.hasPendingWork(id)` | stranding a pending `ask`: a CLI process blocked on a button click is work this conversation is doing from outside any turn |
| `AgentSession.reclaimState() === 'resumable'` | silently restarting the user's task on a harness that cannot reload a stored session |

A reverse command also counts as activity (`handleReverse` → `registry.touch`), so an
agent whose turn ended but whose background job is still reporting through
`talkcode send` keeps its child. A session that reports `unresumable` is left
resident and said so once, not once a minute.

Verified resumable on the three harnesses in use: `claude` (claude-agent-acp advertises
`loadSession: true`), `opencode` 1.18.18 (same, plus `sessionCapabilities.resume`), and
`agy` (`--conversation=<id>`, recorded as soon as its `init` event names one).

### Automatic review

`review.ts` reads a quiet conversation and, if it has anything to teach, has an `agy -p` propose
changes to the managed skills; the gateway applies them through skills-store's own rules
(`docs/skills.md#auto-review`). Off unless `review.agent` names an agy agent.

**The trigger is reclaim's own moment, expressed as a sweep.** `eligible` is the whole rule:
quiet for an hour, no turn running, no pending `ask`, and either the child is gone or it can
never be reclaimed (reclaim off, or `reclaimState() === 'unresumable'`). That one predicate covers
the four cases the plan names — the reclaim that just happened, `/kill` and `/new` an hour later,
a conversation a harness will never let us reclaim, and the backfill after a restart (no state at
all, so `reviewCandidatesFrom` defaults it to stopped and takes the idle clock from the library).
It is a sweep rather than a hook on `reclaimSession` because a sweep is also the only thing that
can see the last two cases at all, and because the timer already exists at the same coarse minute.

**Three messages since the last review.** `reviews.json` (`review-state.ts`) holds, per
conversation, the last message id a review saw — the same integer `reviewWindow` uses to decide
what to quote. "Three" counts `role: user, kind: normal` rows, so a scheduled turn or a sub-agent
prompt in the same topic does not count as the person speaking.

**One at a time, six-hour back-off, and a 24-hour freshness rule.** `sweep` is guarded by a flag,
so a review that outlives the minute simply makes the next tick a no-op. There is no daily cap:
the per-conversation watermark is what stops the same conversation being reviewed again, and a
conversation whose newest message is over a day old is skipped, so turning the feature on cannot
replay months of history. A failed run records a retry time instead of advancing the watermark, so
a broken reviewer is not retried every minute. And a mark that cannot be written to disk is held
in memory (`review-state.ts`): with no cap, a full disk would otherwise leave the watermark
unchanged and review the same conversation on every sweep.

**The reviewer cannot touch anything.** One `agy -p` on the agent's machine, in an empty directory
that is removed afterwards, with every permission class denied (`AGY_NO_TOOLS`). Measured on agy
1.5.0 (2026-11-04), and both halves contradict the plan: print mode WITHOUT
`--dangerously-skip-permissions` still auto-approves file writes, and `deny: ["*"]` denies
NOTHING (`"*"` names a permission class literally). The explicit list refuses `write_file`,
`command`, `read_file` and `mcp` — each reported "Matches user-configured deny rule" — and the
same prompt wrote nothing. A tool in a class not in that list would not be denied; the list is
part of the security contract (AGENTS.md invariant 8). `runAgyReview` is injectable so no test
starts a model.

**The prompt goes on stdin, not in argv.** Linux caps one argument at 128 KB (`MAX_ARG_STRLEN`),
and the conversation window alone is 40k characters — ~120 KB of Chinese — before eight used
skills at 20 KB each. Measured: a 360 KB `-p=` fails with "Argument list too long", and a 231 KB
review prompt through stdin answers normally. So the run is driven the way the resident runtime
drives agy: `--input-format=stream-json --output-format=stream-json -p=`, one NDJSON
`{"event":"user","message":{"content":…}}` frame on stdin, the answer read off the `result` event
(and the `agent_response` deltas before it). Remote reuses `RemoteHost.run`'s body as the child's
stdin, so the temporary directory stays empty.

**Who writes.** Only the gateway, one change at a time through `createSkill` / `patchSkill` /
`writeSkillFile`. A change the store refuses — a taken name, a file outside the three
directories, a version that moved while the reviewer was thinking — is dropped and logged; the
rest of the answer still applies. The reviewer's own output and the prompt are filed in the
library as a `review` session, which search and `list` leave out (`history/store.ts`).

**What the person sees.** One line, and only when something changed: the skills, the `revert`
command for each (or `archive` for a create), and any preference the reviewer noticed. No change,
no line — a review that says "nothing to do" every hour is noise.

**What the library keeps.** `record()` files the session (prompt + raw answer, or the prompt alone
when the run failed); `writeResult()` then attaches the result row — each change with `applied`,
the store's `error` when it refused one, the `revertId` a `revert` names, the preference
suggestions, the shape-check rejects, and the outcome `classifyReview` derives from them. A failed
run is filed too, so "why was this conversation never reviewed" is answerable from the web UI
instead of only from the log. `review-panel.ts` turns those rows into the Reviews tab's entries,
reads the quota from the same `ReviewStateStore` the sweep writes, and marks an old review (raw
answer only, no result row) as inferred. `review-result.ts` holds the wording and the
classification both sides share; the panel is read-only — the undo is the command the row names.

## Scheduled tasks

An agent registers them (`talkcode schedule add …`, documented to it on demand by
`talkcode help schedule`); the daemon keeps and runs them. The decisions are
[`core/schedule.ts`](../core/README.md) — when a task next runs, whether a late run is still worth
making, every sentence said about one — and the files here do the timing and the IO.

**Why the gateway schedules at all.** The harnesses have schedulers (Claude Code's CronCreate), and
they live in the harness PROCESS — which this daemon reclaims after an idle hour and restarts on
every upgrade. A "every morning at 8" made that way is gone by lunchtime. A task here is a file and a
timer in the one process that is always up. The harness tools are left enabled: the gateway does not
edit an agent's toolbox, and the help page says which one survives.

```
schedule add ──IPC──► ScheduleService.add ── core buildTask (every rule, every refusal) ──► ScheduleStore
                                         └── card posted in the caller's conversation (the daemon's words)
Scheduler.look ── core decide ──► run │ skip │ missed │ expire │ done
      run ─► ScheduleService.run ─┬─ bash  → schedule-bash (process group, tail + log) → result posted
                                  ├─ fixed → notice, then registry.runScheduledPrompt in THAT conversation
                                  └─ new   → registry.openScheduledConversation (new topic, or throwaway)
                                             → notice → runScheduledPrompt → released if throwaway
```

What each piece is shaped by, one line each:

- **At most once.** `lastPlannedAt` is written before a run starts, so a daemon killed mid-run does not
  make it again on restart. The next run is the first planned time after it.
- **Catch-up is one run, the latest.** A run missed by less than `CATCH_UP_GRACE_MS` (1 h — the update
  that restarted us) is made once when the daemon comes back; older is recorded `missed`. After a long
  outage an every-minute task makes one run, not a burst.
- **No overlap.** A run due while the previous run of the same task is still going is `skipped`.
- **One timer, capped at a minute.** Re-armed after every look for the earliest thing due, so a host
  clock that jumps costs at most a minute and no timeout comes near Node's 2^31 ms ceiling.
- **A fixed-session run is a SOLO turn** (`InboundMerger.enqueueSolo`): it waits behind the turn
  running there, is never handed into it or merged into what the user is typing, goes behind the
  user's own queued messages, and gets no reactions (there is no platform message). The reverse does
  not hold — a message typed during it is handed into it like into any turn.
- **A fixed-session task lives 24 h** (`FIXED_SESSION_WINDOW_MS`, the operator's rule): a topic a
  schedule talks into forever grows a context nobody reads. `--at` beyond the window, or a cron with
  no run inside it, is refused at registration; at the end it is marked `expired` and kept (visible,
  deletable, not resumable), and a line says so where it ran.
- **A topic keeps its agent** — so a fixed-session task for another agent is refused at registration,
  and a run that finds the topic answered by someone else (after `/new`) is skipped with a line,
  never rebinds.
- **A new-session run gets a topic where the platform can open one without a message** (web UI,
  Telegram forum groups), created already named `[agent] ⏰ name · time` and recorded so the namer
  leaves it alone; the user can carry on in it. Elsewhere it runs in a throwaway conversation
  (`schedule#<id>#<planned>`) that posts into the target and is released afterwards. A topic that
  comes back with an empty lane (Slack's `thread_ts` with no message) is treated as no topic:
  posting into the channel instead would put the run into the person's own conversation.
- **A daily-session run keeps one topic per local day.** The first run of the day opens it (same
  shape as a new-session run), names it `⏰ name · YYYY-MM-DD`, and records that day and topic in
  the task; later runs that day — including a catch-up whose planned time was before midnight —
  join it, and the next day opens a fresh one. The day is the task's own `tz`, taken from the
  run's planned time. A restart reads the topic back from `schedules.json`; a topic deleted
  meanwhile is reopened on the next run — the web UI answers `hasThread`, and elsewhere a post
  into the topic that fails clears the record. There is no throwaway fallback: a platform that
  cannot open a topic with no message is refused at registration (`standaloneThread`), a create
  that fails or comes back empty fails the run and says so, and consecutive runs failing the same
  way are reported once rather than on every run.
- **A new- or daily-session task can name its model** (`--model`). The id is checked at
  registration against the agent's own `/model` list — the caller's session for its own agent, a
  throwaway one for another — and a name it does not offer is refused there, with the list. Each
  run then applies it through `session.setModel` (the `/model` path), with the session brought up
  first so the harness answers now: `applyModelPreference` at spawn is best-effort and would keep
  its default, which is right for an operator's config typo but not for an explicit instruction,
  so a refusal here fails the run and says why. A conversation that already has an override is
  left alone — that is the task's own earlier application in a daily topic, or a person's
  `/model`, and the person wins. A daily task also records a person's `/model` in the day's
  `daySession`, because that override is in memory and a restart would otherwise let the next run
  put the task's model back. A fixed-session task runs in a person's topic and keeps its model, so
  `--model` is refused for it.
- **A bash run is not an agent**: `bash -lc` in its own process group (killed whole on timeout — `a |
  b` forks), the daemon's environment minus the reverse-command token, a 16 KB tail kept for the chat
  and the full output in `<configDir>/schedule-runs/<id>/` (20 per task). Longer than 3000 characters
  inline, the log is attached.
- **Every run speaks first.** A notice before an agent run, the result for a bash one — output that
  arrives unasked always says which task produced it.
- **Cards are the daemon's.** Register, pause, resume and delete post the task's card in the caller's
  conversation, never left to the agent's retelling. `/setting` (below) answers in its own message
  instead of posting a second one.
- **Trust.** Registering needs a reverse-command token — an agent the operator already runs with
  full tool access — so a bash task grants nothing that agent could not have written into crontab
  itself. What IS new is persistence past the session: a prompt-injected agent's task outlives the
  conversation that planted it. That is what the cards and the `/setting` list are for — nothing
  is scheduled that the user was not shown — and why the task file is 0600. `access.allowFrom`
  remains the gate ([security invariant #1](../../AGENTS.md#security-invariants)).

`/setting` reaches the tasks through one extra button after the settings rows. They are not rows —
every row is a config.yaml value with a parser and an ack — so the button edits the settings message
into the task menu (`core/schedule-menu.ts`), and "◀ Settings" edits it back: one message, handed
between `pendingSettingsMenus` and `pendingScheduleMenus` under the same reqId. Pause and resume are
one tap; delete asks twice. Where there are no buttons, `/setting schedule [pause|resume|delete|run
<id>]` does the same by typing and answers with the card.

## `TurnRunner`

One turn, end to end. It receives a narrow DI interface (`TurnRunnerDeps`) rather than
the whole `ConversationRegistry`, to avoid bidirectional coupling: the registry stays the
sole owner of state and lifecycle, and the runner borrows read-only views (`agentIdOf`,
`tokenFor`, `getModelOverride`) plus a few write entries (`setLane`, `adoptThread`,
`touch`).

Per turn it: resolves the platform instance from the batch (a shared-scope conversation
may hop instances between turns, so this is per-turn) → resolves the outbound address
(opening a thread first when `autoThread: perTurn`, so the whole turn lands in it) →
starts a typing keep-alive loop (Discord's indicator self-expires ~10 s) → builds a
`StreamBuffer` factory and a `ToolRenderer` → runs the agent turn → final-flushes with
the footer.

Two mechanisms worth understanding before editing:

**What the prompt actually contains.** `mergePrompt` joins the batch and adds nothing
about who sent it. No sender name is added in any kind of conversation. The `[<authorName>] `
prefix that used to go on outside DMs was removed because `access.allowFrom` admits one
person here, so it never told two speakers apart. And a Telegram private chat in topic mode
reports `kind: 'thread'`, so that one person's own DMs carried their handle on every turn. A
quoted reply prepends one `(replying to: "…")` line, with no author for the same reason.
Attachments append a block: readable text inlined, anything else as one
`[Attachment <name>: <path> (<mime>)]` line — where it is, not how to open it. A slash command is
passed through bare, since the SDK decides native-command execution by the leading `/`. That is
the whole list: the runtimes add nothing to it, on any turn (see "What a session is given").

**The effects chain.** All stream-event side effects are serialized into one promise
chain (`enqueue`), so "text push → tool-boundary flush → tool bubble → trailing text"
execute in strict arrival order with no interleaving. Failures are swallowed into the
chain — rendering is best-effort — rather than escaping as unhandled rejections.

**`TurnRef`.** The stream callbacks are extracted into `buildStreamHandlers`, so the
"current buffer" and "did we produce output" cannot be bare `let`s (a mutable binding is
not shared across that function boundary). They live in one mutable object read and
written by both ends. Never cache `ref.stream` — it is rotated at segment boundaries.

**Outbound lanes.** Every write a turn makes goes through the shared per-chat budget (see
[`paced-adapter.ts`](#paced-adapterts)), but not every write is worth the same wait:

| lane | what goes on it | under congestion |
|---|---|---|
| `reply` (default) | the body, the footer, error notices, reactions | queued, never dropped |
| `progress` | tool bubbles | superseded by a newer paint, or dropped when stale |
| `typing` | the keep-alive beats | dropped immediately |

That is also why `finalize` ends with `tools.settle(outbound.finalizeWaitMs)` followed by
`tools.abort()`. `settle` returns the moment everything has landed, so in the ordinary case
neither call does anything. When it does not — a chat Telegram has paused for 229 s — the
turn completes and gets its ✅ instead of being held open for the same 229 s, and the
renderer stops trying. The `abort()` is not optional bookkeeping: an armed retry keeps the
whole render alive on a timer, so without it a finished turn would go on repainting its
bubble for the life of the process.

Turn outcomes:

- **Normal**: final flush with the footer.
- **Stopped** (`signal.aborted`, from `/stop`): finalize the partial reply cleanly — drop the
  no footer, no ✅, skip the command fallback.
- **Failed**: log the stack, deliver what the turn had produced (the same no-footer
  finalize as a stop), then send a capped (300 char) `❌ This turn failed: <reason>`
  in-channel and rethrow for the merger to mark ❌. The flush is not optional: text is sent
  when its segment completes, so everything after the last tool — usually the conclusion —
  exists only in the buffer until finalize, and skipping it threw the answer away
  (2026-09-29, `turn-failure.test.ts`). The reason is surfaced because the
  runtime error messages (`auth_required`, startup/turn timeout, command not on PATH) are
  written to be user-actionable — a bare ❌ reaction wastes them.
- **Command with zero output**: some harness built-ins (`/compact`) produce a
  marker-only shell that the harness strips to nothing, leaving the chat silent. A
  fallback note is sent instead.

The **per-turn silence watchdog** (`session.turnTimeoutMs`, 10 min) bounds *silence*,
not total turn length — the timer resets on every agent update. On trip the subprocess is
force-disposed and the turn fails.

Silence, though, has more than one cause, and the watchdog can only report the silence.
`harness-log.ts` closes that gap for harnesses that admit their failures **only to their
own log file**: opencode retries an upstream rate limit internally, reporting it neither
over ACP nor on stderr, so every affected turn read as "hung" ten minutes later
(2026-09-17). The daemon's ACP session id appears verbatim in opencode's log, so one
conversation's errors can be picked out of a log shared by all of them:

- **During the turn** (60 s poll, only for harnesses with a probe) each distinct reason is
  announced once through `onNotice` — a separate message, never folded into the agent's
  own reply.
- **On timeout** the log is read once more *before* `dispose()`, which would destroy the
  session id the lookup needs, and the reason is appended to the failure message.

It never ends a turn: a logged error is evidence something went wrong, not that the turn
is lost — opencode often retries and wins. A missing file, a renamed field or an
unparsable line yields nothing, which puts the message back to exactly its old text.

Claude Code's equivalent is its API retry loop, and that one can be heard over ACP, but
only if the client asks. Reported 2026-10-06: the API gateway failed for ten minutes, and
Claude Code retried silently until the watchdog failed the turn as "hung".
claude-agent-acp turns each retry into a typed failure record (its private AIR
`sessionFailure` extension), and sends those records only to a client that advertised the
capability at `initialize`. The runtime advertises it for the `claude` harness only (see
`session-failure.ts`). Then:

- Each retry is a `session_info_update`, so it re-arms the watchdog like any other update,
  and is announced through `onNotice` once per cause, not once per attempt.
- A turn that fails anyway **resolves** `end_turn` with the record in `_meta`, where the
  old contract rejected the prompt. `runTurn` reads it and fails the turn with the
  record's title, so a failure can never be reported as a success.
- A failure with no turn (a background cycle's own) is announced through the follow-up
  sink's `onNotice`, without opening a background-update message.
- Records that `session/load` replays from history arrive before the first prompt and are
  only logged.

The before/after was reproduced against the real adapter and Claude Code with a fake API
answering 503 (`project-scripts/aa-air-failure/`): without the capability the turn failed
as hung while Claude Code was still retrying, and with it the turn ended with the
provider's own error text.

One more silence is not a hang at all: claude-agent-acp's **folded prompt** (upstream
#1145, unfixed as of 0.84.0). A prompt sent while Claude Code is reporting a finished
background task on its own is folded into that cycle and answered there, but the cycle's
result is filed as autonomous and `session/prompt` never returns. The adapter still says
the cycle ended — the result-tied `usage_update` carries `_meta["_claude/origin"]` — so a
turn that sees an autonomous cycle end and then hears nothing of its own for
`FOLDED_PROMPT_GRACE_MS` (30 s, or half the watchdog if that is less) ends normally with
what it rendered. It sends no cancel, because a prompt merely *queued* behind that cycle
looks the same until its own output starts; if that output is later than the grace, it
still arrives, as a background update. The abandoned prompt is settled by the adapter at
the next prompt, so a turn only ends on a `stop` carrying **its own** prompt's response —
otherwise that late settlement would end the next turn before its reply was read.

## What needs the person: outcomes and sub-agents

One person watching their agents is the ceiling on how many they can run (the numbers are in
`delegation.ts`'s header). Three pieces answer it, and all three decide from facts, never from what
a reply says — core/topic-stage.ts carries the reasoning, borrowed from DeepSeek's Super-agent
prototype, which refuses to infer "waiting on a person" from prose.

**TurnOutcomes** (`turn-outcomes.ts`) hears every turn's start and end from TurnRunner
(`recordTurnStart` / `recordTurnEnd`, exactly one end per start, on every way out) and keeps what
the last one left: a finished reply in full — its first line for a platform's list, the text for
the update card — or a failure, its reason and the whole error (`TurnFailure`, thrown by the
runtimes wherever they know why; anything else is `other`). It pushes that to the platform
(`PlatformAdapter.setActivity`) and tells delegation. A start supersedes the last outcome; a
`/stop` leaves none.

- **`hooks.turnFailed.continue`** schedules the operator's message after a failure whose reason it
  names, as a solo turn with `CONTINUE_SENDER` — attended, unlike a scheduled run, so a
  `permissions: ask` agent still asks. The count of continues sent survives the continue's own turn
  (it may fail too) and is reset by a normal end, a stop, or anything the person does
  (`personActed`, called from `route()` for every accepted message, and from `/stop` `/new` `/kill`).
  A turn that starts for any other reason calls a waiting continue off.
- **Interrupted turns.** `conversations.json` marks a conversation `inFlight` from a turn's start to
  its end. A mark still there when the daemon starts (`recoverInterruptedTurns`, after the platforms
  and IPC) is a turn the last process never finished; it is said in its lane and handled as a failure
  with reason `restart`. Two writes per turn, on top of the lane write that was already there.

**Sub-agents** (`delegation.ts`) are an agent handing parts of its job to other agents, each in a
topic of its own nested under the asking one — on a platform that records that relation
(`PlatformAdapter.parentOf` / `childrenOf`, today the web UI's `Topic.parent`), which is the only copy
of it: the daemon keeps none, so deleting a topic on the page is what ends it. Three structural rules:

- By default (`delegation.confirm`) `task-new` only proposes. The proposal stays open until the
  person answers: the first card goes up
  after `PROPOSAL_GATHER_MS`, and a later call while that card is on screen re-renders it with the new
  item on it, so a burst is one card however far apart the calls are. It is put up through the
  daemon's `askButtons` with `acceptsText: false`: a typed reply is the person's next message to the
  agent, never a yes — and it drops the proposal (`supersedeProposals` → `personSpoke`), so the
  re-proposal that follows starts a fresh card rather than appending to the one it means to replace.
  A newer card aborts the one on screen (`signal`). With `delegation.confirm` off, `task-new` opens
  the part at once (so its answer can say it is running) and queues the same list as a card without
  buttons, gathered the same way and never dropped by a message from the person — but only in a
  conversation with no parent: a sub-agent's own topic still puts up the confirmation card, so an
  agent cannot chain more agents without a tap. `task-agents` lists
  the conversation's own agent first: `task-new` has no default, and the first usable row is what an
  agent picks.
  Start opens each part with `ConversationRegistry.openTask` (`createThread` with `under`), whose
  `handTo` shows the text under a `↳ From [parent]` header and ingests it with `DELEGATE_SENDER`.
- A conversation acts only on topics it opened (`Delegation.child` checks `parentOf`).
- Updates come back through `childChanged` — TurnOutcomes' `onNeedsPerson`, and a sub-agent's ask —
  only for turns the parent handed out (`handedOut`, in memory): a turn the person starts in a
  sub-agent's topic is theirs. Gathered for `CARD_DELAY_MS`, shown folded in the parent's topic,
  then run there as a solo turn with `UPDATE_SENDER`, which the namer skips. The card quotes what
  the sub-agent said — reply, question or error, line breaks kept — within `CARD_ITEM_CHARS` for
  one entry and `CARD_TOTAL_CHARS` for a burst, both hard limits; one card lists at most
  `CARD_MAX_ENTRIES` and folds the rest into a line pointing at `talkcode tasks`. A cut states its
  full length and where the rest is, by the turn's number: the card quotes `turns.seq` (carried from
  `TurnEnd.turn` into `KeptText.turn`), so `task-read <topic> --turn <n> --full` reads that reply
  back and `--turn <n>` reads a failed turn's whole error. By number, because a later background
  burst would otherwise be "the last turn" before the parent reads it; the ❌ notice in the topic
  carries only the error's opening. A question names no turn and no command: the ask is the
  gateway's own message, not a row the library keeps. The stage is read
  without `seenAt`: the person having read a reply does not mean the parent agent has.
- `task-read` reads the library, not the platform's own history: the same rows and the same
  `READ_FILTER_OPTIONS` as `sessions read`, plus its own `--tail` (the last lines of each message)
  and `--reply` (the last normally-ended turn's reply, whole). `--turn` carries that turn's record,
  including the failure detail, which is why `history` is a Delegation dep.

`/super` is not the daemon's: it is the bundled `super` skill (`skill-super/`), linked beside
`talkcode` by `skill-link.ts`. The daemon's one concession to it is naming — `jobInCommand` seeds a
`/super <job>` topic's name from the job, where every other command names nothing.

## The status strip (`status-board.ts`)

What the footer says once per reply, kept current between replies, for a platform with somewhere to
put it — `PlatformAdapter.setStatus`, which only the web UI implements (the strip above its
composer). The registry owns a `StatusBoard` and feeds it from the same `TurnRunnerDeps` that feed
`/context`: `recordUsage` (context and cost), `recordModel`, `recordEffort`, `recordQuota`, and
`recordTurnComplete`. `forgetUsage` — `/new`, `/cd`, a rebind — resets it, which clears the strip.

The constraint it is built around is cost, because the user asked for exactly that:

- **Nothing is polled.** Every value arrives on an event the daemon was already handling.
- **Repeats are dropped and changes throttled**: at most one status per conversation per 2 s,
  leading and trailing, so a turn emitting a `usage_update` per API call costs the page a few
  updates and the last one always lands.
- **A lane on a platform without `setStatus` does no work at all** — in particular no file reads.

Each harness reports a different subset, and an absent field is shown as nothing, never as a zero:

| Field | Source |
|---|---|
| model, effort | `onModel` / `onEffort` (ACP config options; agy's `init`, else `agy -p=/model` or, before 1.4.7, its status line) |
| context | `onUsage` — ACP `usage_update`; agy's stream `usage` (1.4.7+) or status line |
| cost | `onUsage.cost` — claude and opencode; kept across the mid-stream snapshots that carry none |
| cache expiry | claude only: `claude-transcript.ts`, read once a moment after each model cycle ends |
| quota | agy only: `agy -p=/usage` (1.4.7+) or its status line, via `onQuota` |

**Why the cache expiry comes off a transcript.** Headless Claude Code runs no status line at all
(probed on 2.1.291: zero invocations in a whole turn), so the `prompt_cache` its TUI status line is
handed never exists here, and ACP carries no TTL. The transcript keeps the API's own
`cache_creation` 5m/1h split and every entry's timestamp; the expiry is the time the last request
went out plus the TTL its prefix was written with. That file is Claude Code's private format —
the module header carries the Hyrum's Law warning, and the failure mode is a missing segment, not a
wrong one. Between reads, a `usage_update` (a request just happened) projects the expiry forward
with the TTL the last read established, so a long turn does not show a cache expiring that it is
renewing on every call.

## Agent runtimes

```
                    AgentFactory  (agent.ts — interface, imports nothing)
                          ▲
                createAgentFactory  (agent-factory.ts — dispatch by harness)
                    ┌─────┴─────┐
              agent-acp.ts   agent-agy.ts
        claude/codex/opencode/     agy
          gemini/custom
```

Everything above this boundary — `ConversationRegistry`, `TurnRunner`, `StreamBuffer`,
`ToolRenderer` — is **protocol-agnostic** and reused unchanged by both runtimes. Keep it
that way: a new protocol means a new sibling runtime implementing `AgentFactory`, not a
branch upstream.

`agent.ts` holds only interfaces and imports nothing from the project — both runtimes
import it, so putting the dispatch there would create a cycle. That is why
`agent-factory.ts` is its own file.

`dispose(conversationId)` fans out to both runtimes rather than tracking ownership:
callers hold only a conversation key, and disposing one a runtime never created is a
documented no-op.

### `agent-acp.ts` — the ACP runtime

The daemon is the ACP **client/host**. Each conversation+agent pair spawns a resident ACP
agent child — one per `(conversationId, agentId)`, which is why two agents can answer the
same topic without sharing a process — and `session/update` notifications are translated
back into `AgentStreamHandlers`:

| ACP | → |
|---|---|
| `session/new` / `session/load` | an `AgentSession` (context across turns) |
| `session/prompt` | `runTurn` |
| `agent_message_chunk` | `onText` |
| `tool_call` / `tool_call_update` | `onToolStart` / `onToolFinish` |
| `available_commands_update` | `onAvailableCommands` |
| `usage_update` | `onUsage` (feeds the footer's context segment; its `cost`, when present, feeds a busy `/usage`) |
| `config_option_update` | `onModel`, `onEffort` |
| `session_info_update` | `onTitle` (renames the chat lane — see below) |
| `session/request_permission` | **auto-approved** — see below |

A `tool_call_update` can also reach `onToolStart`: a call is drawn as soon as its status
advances, so a harness that announces the call before its parameters (CodeBuddy Code sends
`{title:"Bash", kind:"other", rawInput:{}}` first, the command after) gets its row corrected in
place by `upgradeToolRow` when the name or preview changes. Only a changed row re-emits, and
nothing re-emits after the finish.

**Subagents.** The `claude` adapter tags everything a subagent produces with
`_meta.claudeCode.parentToolUseId` — the id of the Agent/Task call that spawned it — and marks
that call with `_meta.claudeCode.subagent`. `translateUpdate` reads both (`claudeAttribution`):
the subagent's tools go out with `ToolEvent.agent` set to the spawning call's `description`, and
any subagent text is kept out of the reply body. The name map is session-scoped, not per turn,
because a background subagent's tools keep arriving after the turn that launched it has ended.
Neither field is in the ACP schema; the contract test in `agent-acp.test.ts` replays the shapes
claude-agent-acp 0.81.2 sent on 2026-10-10. The adapter keeps a subagent's own text internal for
a client that declares neither ACP `subagents` nor `subagent-transcript`, and this one declares
neither — declaring either would start delivering it, and it would then need somewhere to go.

The `claude` adapter is **bundled** as a dependency and resolved via
`resolveClaudeAdapterEntry`, so it needs no separate install. Every other harness —
`codex`, `gemini`, `opencode`, `dsh`, `custom` — is located on PATH.

`codex` is the one worth explaining, because it used to be bundled too. Its adapter
(`@agentclientprotocol/codex-acp`, replacing Zed's deprecated `@zed-industries/codex-acp`)
declares `@openai/codex` as a regular dependency, whose platform binary is ~284 MB
unpacked. Bundling that would tax every `npm i -g talkcode` for a harness most
operators never configure, while the operator who *does* configure it has already installed
and logged into the codex CLI by hand. So it follows the opencode/dsh contract instead:
install it alongside the daemon, and `doctor` names the package when it is missing.

#### One reader for the whole session, not one per turn

The SDK's update queue has exactly **one** reader (`pumpUpdates`), started when the session comes
up and running until its child goes away. A turn does not read the queue at all: it installs its
translation state, sends the prompt, and waits for the pump to report the queue's `stop`.

Two constraints force that shape, and the second is the load-bearing one.

**A turn's answer is not the end of the harness's output.** Claude Code puts long work in the
background — a `run_in_background` Bash call, a background Task — and ends its turn saying it will
report back; when the work finishes the Agent SDK re-invokes the model on its own with a
task-notification. claude-agent-acp settles the ACP prompt at the turn's terminal `result`
precisely so the client unlocks instead of blocking on that work (its own comment cites issue
\#773), and then keeps emitting `session/update` notifications with no prompt in flight, stating
that "the consumer keeps draining afterward (absorbing idle and forwarding any background
output)". A loop that returned at `stop` read none of it: every character the agent produced after
a long script finished went into the queue unread and was cleared as residue on the next turn. The
chat simply went silent at the moment the answer arrived.

**The queue cannot be handed back and forth.** `AsyncQueue.next()` pushes a waiter when the queue
is empty, and an abandoned waiter still consumes the next value that arrives — so "drain between
turns, then let the turn read again" is unimplementable: whichever reader was waiting when the next
turn began would swallow that turn's first update. A permanent reader whose *destination* switches
has no handover to get wrong.

What a permanent reader has to handle that a per-turn loop got for free:

- **Ownership across the await.** `active !== session` is checked before *and* after every read.
  `turnState` / `endTurnWait` are session-wide, so a value from a child replaced while the read was
  parked would otherwise end — or be rendered into — the turn of a freshly spawned one. The old
  waiter died with its turn and could not do this.
- **Rejections mean two different things.** A failed prompt rejects the queue **once**; a closed
  connection fails it **permanently**, so every later read rejects with the same error. A
  consecutive-rejection counter with a small backoff tells them apart, and on standing down the
  reader *tears the connection down* rather than returning — leaving `active` set with no reader
  would present a session that looks ready but can never deliver a `stop`.
- **The turn needs a failure path of its own.** It waits on `stop` for success (the harness's last
  updates precede the prompt response, and the pump delivers them in order), but on **promptDone's
  rejection** for failure — because a failed prompt produces no `stop`, and `AsyncQueue.reject` is
  a no-op once the queue has terminally failed. Without that the turn waited out the whole silence
  watchdog and blamed the agent for "sending no update", or hung forever with `turnTimeoutMs: 0`.
- **One bad notification must not kill the reader.** `translateUpdate` is wrapped: an escaping
  throw would leave the child permanently deaf, where the old per-turn loop merely failed that turn.
- **Replayed history is not output.** `session/load` replays the stored conversation as ordinary
  notifications (the resumed session is attached *before* the request precisely so they land in
  this queue) and the deleted drain discarded them — "history must not re-render to the IM". A
  `promptedYet` flag now does that job: until this child has been asked for something, renderable
  updates are dropped and only reported facts are kept. Without it, every daemon restart would
  re-narrate the previous conversation into the chat as a background update.
- **A cancelled tool's tail is not output either.** See below.

The silence watchdog (`session.turnTimeoutMs`) moved with the reader: one timer per turn, re-armed
by the pump on every update it hands to that turn, so it still bounds silence rather than turn
length. It also learned the difference between a hang and a long script — a tool call emits nothing
for exactly as long as it runs, so from outside the two are identical, and the collision was
guaranteed rather than unlucky: Claude Code's Bash tool allows up to 600000ms, which is *precisely*
this watchdog's default. A turn quiet past its deadline with a tool call still open is therefore
forgiven once, for `TOOL_SILENCE_FACTOR`× longer (30 minutes at the default), and only then failed
— finite, so a genuinely wedged tool still cannot pin a conversation in `running` forever.

The pre-prompt residue drain is gone with all of this. Nothing accumulates in the queue any more,
and `session_info_update` — which claude-agent-acp sends from its turn-end idle handler, i.e.
behind the `stop` — used to be salvageable only as next-turn residue (the log line
`drain: dropped 1 residual update(s)` after every single turn). It now arrives when it is sent, so
a lane is renamed a turn sooner.

#### Out-of-turn output becomes a follow-up message

Everything the pump reads with no turn running goes to the conversation's `FollowUpSink`
(`TurnRunner.followUpSink`), which renders it as a **new** message in the conversation's lane,
introduced by a `⏱ background update` bubble. New rather than an edit: the reply it follows was
already sealed and footered, and a chat that silently rewrites an old message is worse than one
that posts a new one.

- **The message opens lazily, and so does the burst.** `handlers()` always answers, because the
  metadata half (title, usage, model) must be recorded whether or not anything is displayed — but a
  message is opened, and a burst announced, only when text or a tool actually arrives. Otherwise
  the post-turn `session_info_update` that claude-agent-acp sends after *every* turn would post an
  empty follow-up to every conversation, log a misleading "rendering a follow-up" line after every
  exchange, and leave each idle conversation holding a three-minute timer.
- **A burst is sealed a moment after the harness reports a result.** In the default `once` delivery
  mode nothing is sent until the buffer completes, so "the work finished" has to be detectable: the
  `usage_update` tied to a terminal `result` carries `cost`, the mid-stream ones do not (verified
  against claude-agent-acp 0.58.1). That marker only *shortens* the timer rather than closing
  outright, because the ACP schema documents `cost` as "Cumulative session cost (optional)" — a
  harness reporting it on every snapshot would otherwise have one report cut into a message per
  snapshot. A long quiet window backs the whole thing up.
- **Closing is awaited where it matters.** `close()` returns a promise, and `runTurn` awaits it
  before writing its own reply into the same lane. Fired and forgotten, a burst sealed by an
  incoming turn would flush concurrently with that turn's answer and the background report would
  land underneath something it has nothing to do with, its marker orphaned above both.
- **A cancel's trailing writes are dropped.** A cancelled tool call still emits its
  `tool_call_update`, after the prompt has settled. Two tests catch it: while `aborting` stands
  (between the cancel and the next turn) anything tool-shaped is the cancelled turn's tail, and
  once a new turn has cleared that flag, the tool ids the cancel snapshotted still identify it —
  which matters because a message sent right after `/stop` starts the next turn within
  milliseconds, so the wreckage would otherwise be rendered into *its* reply. That is the case the
  deleted drain described verbatim.
- **A rendering burst reads as running.** Opening the message takes a typing hold
  (`TurnRunner.holdTyping`), released after the seal's flush — every surface that says "running"
  reads typing, and on the web UI that is the topic's dot, its "running" label and the Stop button.
  Holds are counted per conversation because a turn and a burst overlap at both ends: `runTurn`
  switches typing on before the runtime seals the previous burst from inside it, and a finishing
  turn's cleanup can run after a new burst opened. Whoever lets go last switches it off.
- **`/stop` reaches a burst, and only a rendering one.** `stopBackground()` sends `session/cancel`
  with no prompt in flight — claude-agent-acp's `cancel()` interrupts the SDK query regardless
  (verified live against 0.81.0: no further output, and the next turn answers normally). It marks
  the burst's open tools ✗ and seals it at once, and records their ids as wreckage *without*
  setting `aborting`, which would stand until the next turn and drop every later background
  report's tool bubbles. It answers false for a burst that only ever carried metadata and between
  bursts, where no model cycle is running and claiming a stop would be untrue.
- **A burst is told the model and effort when it begins**, the same up-front report `runTurn`
  makes. Both arrive with `session/new` and are never re-sent unless they change, so without it a
  background report's footer fell back to config — which for the `claude` harness names no model.

Where the message goes comes from `ConversationState.lane`: the lane the last turn ran in, recorded
by `setLane` and never cleared. It used to be an *active* address wiped at turn end, which is why
three separate things were dropped after a turn — background output, a late harness title, and a
reverse command from a job the agent left running (`resolveAddress` answered "this conversation has
no active turn right now" and the job's whole report went nowhere). All three read the lane now.
Nothing reads "is a turn running" off an address; the merger's phase is the authority on that.

That last one widens the reverse-command token from turn-scoped to conversation-scoped; the cost is
spelled out at `resolveAddress`.

The agy runtime already had a persistent stdout reader but no such sink; it has never been observed
to emit anything after `result`, so it **logs** an out-of-turn event instead of dropping it
silently. If that log line ever appears, the assumption is wrong and agy needs the same wiring.

#### Starting a session without running a turn

`AgentSession.ensureSession(token)` does everything the first turn does except send a prompt:
spawn, `initialize`, `session/new` (or `session/load`). It exists because the model list arrives
in the `session/new` response, so `modelSelector()` genuinely has nothing to report before a
conversation's first turn — and `/model` used to answer "send a message, then /model", which is
unactionable right after `/cd` invites you to pick a project and then a model.

`ensureStarted` shares one in-flight startup between concurrent callers. That is load-bearing now
that there are two of them: `active` is assigned only at the *end* of startup, so an unguarded
second entrant would spawn its own child, overwrite `proc`, and leave the first as an orphan that
no `dispose` can reach while it still holds the harness's session.

#### A message sent while a turn runs (`steer`)

A message the user sends mid-turn is handed to the running turn — the way Claude Code's own CLI
queues what you type while it works and shows it to the model at the next tool boundary — and
nothing is cancelled: the tool that is running finishes. `InboundMerger` offers it
(`deps.steer`), `TurnRunner.steer` builds its prompt exactly as a turn's and passes it to
`AgentSession.steer`, and the runtime answers `joined`, `detached` or `refused` (`SteerOutcome` in
`types.ts`). Refused messages wait behind the turn and run as the next one, which is all the
gateway did for any harness before. `TurnRunner` refuses two kinds itself: a slash command (it only
runs as one at the start of a prompt), and a message from a lane the turn is not answering in.

How a harness takes one is read off its `initialize` (`acp-steering.ts`, where the evidence lives),
probed 2026-10-10 with a message sent six seconds into a thirty-second foreground command:

| mode | harness | what is sent | what happened |
|---|---|---|---|
| `prompt` | claude (claude-agent-acp 0.81, Claude Code 2.1.296) | another `session/prompt` | queued at priority `next`, absorbed at the tool boundary (`absorbed_mid_turn`); the command ran its 30 s; one reply answered both |
| `steer` | codex (codex-acp 2.2.1, codex 0.160.1) | `_session/steering` → app-server `turn/steer` | read before the next model request; same result; one `end_turn` |
| `none` | opencode 2.0.26 | nothing | a second `session/prompt` is rejected (-32603) and the message lost — so it is never sent |

agy is not ACP and offers nothing comparable over stream-json (a second message runs as the next
turn), so `agent-agy.ts` has no `steer` and everything queues.

Two things in `runTurn` exist for `prompt` mode:

- **The turn ends on the LAST prompt it sent**, not its own. When Claude Code absorbs a queued
  message, the adapter settles the first prompt as soon as the absorbed one starts being answered,
  and the reply streams under the second. Ending on the first `stop` would close the turn and push
  the very answer the user asked for into a background-update message. `send()` re-points
  `promptDone`/`ownResponse` at each prompt, and any of them rejecting fails the turn.
- **A message sent while the turn is still starting waits** (`promptSent`) instead of being
  refused: a cold start — spawn, `session/load` — can take seconds, and refusing would hold the
  message back for the whole turn.

claude-agent-acp also implements `_session/steering`, deliberately unused: it delivers at priority
`now`, which pre-empts — probed, Claude Code moved the running foreground command to the
background, answered at once, and the command's result came back later as a background
notification. A different feature from a queue. `steer` mode sends `idleBehavior:
"promptRequired"` so a harness that finds no turn hands the message back; codex-acp ignores that
and starts a detached turn, which is what `detached` reports — its reply then arrives through the
follow-up sink.

> **The daemon auto-approves every tool permission request.** Agents run with full tool
> access. There is no per-call policy in the config schema by design — tightening tool
> permissions is delegated to the harness itself via that agent's `args`/`env`. The
> daemon's only access control is `access.allowFrom`. See
> [security invariants](../../AGENTS.md#security-invariants).

`onModel` reports what the harness says is actually serving the session, which is more
accurate than the config: the `claude` harness takes its model from `ANTHROPIC_MODEL` and
resolves aliases like `opus[1m]` internally. Header = what was asked for; footer = what
ran.

`onEffort` is the same idea for reasoning effort, read from the option in ACP's
`thought_level` category rather than by id, because the ids differ (`effort` on claude and
opencode, `reasoning_effort` on codex). It is re-reported with `undefined` when an update
drops the level, so the footer never keeps showing a level the session left.

`/effort` writes that same option (`setEffort`, sent to whatever id the harness gave it), and
the choice is held beside `modelPreference` as `effortPreference`, surviving `resetHandles`.
Unlike the model's, it is re-applied after `session/load` as well as `session/new`, and after
a runtime `/model` — the first because it is not optional: probed 2026-09-23, claude-agent-acp
0.81.0 and codex-acp 1.13.0 both reload at their default level, so every idle reclaim would
otherwise undo the user's choice (opencode 2.0.14 keeps it, and then the re-apply costs
nothing, since an unchanged level is not re-sent). The order on a fresh session is model
first, then effort, because the levels on offer are the model's.

### `agent-agy.ts` — the Antigravity runtime

Read the file header before touching this. `agy` **does not speak ACP** — it has no ACP
mode at all. A community adapter (`agy-acp`) exists but drives agy through a PTY, reads
its internal SQLite/protobuf records, and **deadlocks permanently on the turn following
any tool call** — fatal for a chat gateway, where the bot would go silent forever after
its first real task. So this runtime speaks agy's own documented headless stream-json
protocol directly.

Protocol mapping (verified empirically against agy 1.1.22):

| agy | → |
|---|---|
| one resident child | an `AgentSession` |
| `{"event":"user","message":…}` written to stdin | `runTurn` |
| `step_update.text_delta` | `onText` (deltas, not cumulative) |
| `step_type:"tool"` ACTIVE / DONE | `onToolStart` / `onToolFinish` |
| text↔tool boundary | `onSegmentBreak` |
| `event:"result"` | turn end (`SUCCESS`; `ERROR` fails the turn only if it did not end in a reply — below) |
| `init.conversation_id` | stored under `(conversation, agy)`, replayed via `--conversation` |
| `init.model` | `onModel` — stored at spawn, replayed at the top of every turn |
| SIGINT | abort (agy has no in-band cancel) |

**`result.status` is about the conversation, not the turn** (agy 1.3.2, measured 2026-10-10).
`num_turns`, `duration_seconds` and `usage` in it are running totals, and once the conversation has
had an API error — even one retried past seconds later — every later `result` says `ERROR` with that
error, including after a respawn with `--conversation`. So `translateAgyEvent` does not take the
status on its own: an `ERROR` fails the turn only when the turn's last output was not the agent's
reply (an `error_message` step, a tool, or nothing). Otherwise the turn completes; if this turn saw
an `error_message` step, `onNotice` says it recovered, and if it saw none — agy repeating an old
error — it is only logged. The `error_message` frame itself carries no reason; the text exists on
the wire only inside `result.error`. A plain HTTP 5xx is retried inside agy's HTTP layer and never
reaches the stream at all. `project-scripts/talkcode-agy-stale-error/` reproduces this in an
isolated `HOME`: error frames through a local proxy that fails chosen model calls, and the stale
`ERROR` by resuming a copy of an affected conversation.

Launched WITHOUT `--disable-slash-commands`, which it used to carry. Re-probed on agy
1.2.0 (2026-09-17): a skill slash expands and answers normally, an unrecognized slash
reaches the model as plain text, and only the eleven commands `agy -p /help` lists are
fatal — one of those in the session answers "…is answered by the CLI itself", sets
`status:ERROR` and exits with code 2, taking every later turn with it. Those eleven are
listed in `core/command-translate.ts` (`HARNESS_CLI_ANSWERED`) and answered by
`runAgyCliCommand`, a one-shot `agy -p=/<name>` run in the conversation's directory —
which is what agy's own error message recommends. So agy's skills work here, while agy
still pushes no command list over the wire: `/agy` switches the conversation and its bare
form acks the binding rather than posting an empty menu.

Models: agy names the one it is serving in `init` — but on agy 1.2.9 only when `--model=` asked
for it; a conversation left on agy's default is named by a one-shot `agy -p=/model` started beside
the first turn (on agy 1.4.7+), or by the status line before that, whose display name is respelled
as the `agy models` id (`onModel` is replayed each turn, because the footer reads a per-turn
record). While `agy` has no in-process protocol switch, `agy models` lists
available choices, and `setModel` switches via a kill-and-respawn strategy: `teardown()` stops the
child, and the next turn respawns with `--model=<value>` while `--conversation=<id>` restores
conversation context intact from local disk. `modelSelector()` reports the parsed model list,
bringing the `/model` menu and command to the agy harness.

That list is cached per factory, and the cache is not the source of truth: Google serves it, so it
grows under a running daemon without agy being upgraded (Opus 5.5 appeared on 2026-10-03 on a
binary unchanged since 09-29). The startup prefetch is therefore only a starting point —
`applyModelCommand` calls `refreshModels()` before every `/model`, which re-runs `agy models`
(~1.5s) and keeps the old list when the answer is empty or the run fails. Clicks on the menu that
`/model` opened do not re-ask; they re-check against the list that `/model` just fetched.

Context usage, on agy 1.4.7 and later: each `agent_response` step's DONE frame carries that model
call's `usage`, and its `input_tokens` plus `cache_read_tokens` is the context as it stood
(`agy-meters.ts`) — the cached part is left out of `input_tokens`, so a Claude turn that hit the
cache read as a few hundred tokens until it was added back. Not `result`'s: that is a running total
over the conversation. agy names no window size anywhere, so the window is
a table of the ones measured off its own TUI status line, and a model not in it gets no context
numbers rather than a guessed denominator. Quota comes from a one-shot `agy -p=/usage` (~3.5s, a
round trip to Google), started beside each turn but at most once a minute per home, renamed to the
pool ids below. A turn's end waits for the `/model` and `/usage` one-shots, bounded by
`SIDE_QUERY_SETTLE_MS`; most turns outlast them.

That replaced the status line in `-p`, because agy 1.4.7 stopped running it there ("no longer
start your custom status line", its changelog). What follows is how an older agy reports, and the
runtime still listens for it: `agy-statusline.ts` installs a shim into
agy's `statusLine` setting, and the shim writes each snapshot to a fourth stdio pipe (fd 3) the
runtime opens when it spawns agy — agy passes the descriptor on to its status-line command, which
is undocumented and carries a Hyrum's Law warning. At the end of a turn `runTurn` waits (bounded)
for the post-turn frame, because agy refreshes the count only after `result`, then feeds the same
`onUsage` the ACP runtimes call. Read that file's header before touching it — it writes to another
product's config, and it carries `isCliEntry` for the reason the reverse-CLI shim does.

The same frame carries agy's quota pools (`gemini-5h`, `3p-weekly`, …), passed on as `onQuota` with
the pools the serving model spends from marked `active`. Frames that arrive mid-turn are passed on
as they land too, for the web UI's status strip; the footer is unaffected, because the settled
reading reported in the turn's `finally` overwrites them. The status line is wired again before
every spawn, not only at construction: on a new machine the daemon starts before anyone has logged
agy in, the construction-time install finds no config directory and skips, and without the
spawn-time check that home stayed unwired until the next restart.

### `agent-common.ts`

Protocol-agnostic pieces both runtimes must behave *identically* on: the child
environment, working-directory resolution (`agents[].cwd`, or an auto-created
`~/.talkcode/agents/<id>`), tool-preview formatting, and child termination (SIGTERM, then
SIGKILL after `KILL_GRACE_MS` — harness CLIs may ignore SIGTERM mid-turn).

`buildAgentEnv` runs at every spawn in both runtimes, which makes it the one place that provisions
what the reverse CLI depends on: the shim at the front of `PATH`, the skill link
(`skill-link.ts`) under the home this agent runs as, and the gateway's own managed skills
(`managed-skills.ts`). It also places the operator's instructions (`instructions.ts`) there; an
agent on a remote host gets all of them from `prepareRemoteSpawn`.

#### Agents on a remote host

An agent with `host:` is spawned through that host's `RemoteHost` instead of `child_process`, and
everything else in this module has a remote twin used at the same points: `prepareRemoteSpawn`
(reach the host, settle the directory there, place the bundled skill, the operator's instructions
and the managed skills), `remoteAgentEnv` (an overlay — the
base is the host's login environment, never this daemon's), `expandRemoteHome`, and
`watchRemoteLink`, which tells the chat about an outage longer than a blip and restarts the silence
watchdog when the link is back (both runtimes' `onSilence` also re-arm while the link is down: an
outage is not the agent being silent). `AgentChild` is what a runtime holds — met by a local child
and a `RemoteChild` alike — so neither runtime branches on where its process is beyond the spawn.

The rest of the daemon follows the same rule — the agent's machine is the one that matters: hooks
and an agent's scheduled `--bash` tasks run there (`schedule-bash.ts` runRemoteBashCommand),
inbound files are written there (`attachment-io.ts` remoteAttachmentSave), `send-file` fetches from
there (`daemon.ts` sendAgentFile), and `/cd`, `/skills`, the claude cache countdown and opencode's
log are read there. The `/cd` menu code is synchronous, so a remote listing is read into
`ConversationRegistry.remoteScans` first; an explicit `/cd` always refreshes it.

### What a session is given: the user's words, two tools, a skill

Neither runtime adds text of its own to a turn. `promptBlocks` sends the user's text as the only
text block on every turn; agy gets the same string. Until 1.40 a `<system-reminder>` went in front of
each session's first turn — see [`src/ipc/README.md`](../ipc/README.md#how-it-got-here) for its
history and why it went.

The user's pictures go in as ACP `image` blocks ahead of that text, on a harness whose `initialize`
claims `promptCapabilities.image` (asked per harness, kept across a rebuilt child like
`loadSession`); the text still names each by its saved path. A harness that does not claim it, and
agy, get the text alone and a log line saying the pictures stayed paths. Which pictures qualify is
core's call (`attachment-ingest.ts` `pickImages`); `turn-runner.ts` only base64s them, for a turn and
for a message joined into one. Verified 2026-10-19 on cc and cx, both fresh and mid-turn: two
screenshots read with zero tool calls. A picture whose pixels do not decode does not wedge the
session on either — Claude Code swaps it for a text note before the request, codex falls back to the
path.

What replaced it:

- **Native tools**, ACP only. `acpMcpServers` lists `talkcode mcp` — named `chat`, so Claude
  Code shows `mcp__chat__send_file` — in `session/new` *and* `session/load`, as a stdio server the
  harness starts per session. Stdio because every ACP agent must support it (2026-10-09: cc, cx and
  oc also advertise http, which would mean a listening port where there is only a 0600 socket).
  Its environment is spelled out — token, socket, and the session's cwd for relative paths —
  because a harness may not pass its own on (codex gives MCP servers an allowlist), and ACP's stdio
  entry has no `cwd`. It is re-invoked through `selfInvocation`, so a test worker, which is not the
  CLI, gets no server at all rather than a broken one.
- **The skill**, every harness that has a known skill directory (`skill-link.ts`): `~/.claude/skills`
  for claude, `~/.agents/skills` for codex and opencode, `~/.gemini/config/skills` for agy — each
  probed by asking the model what it sees, because a directory a harness documents is not
  necessarily one it reads (agy's own help names `~/.gemini/antigravity-cli/skills`, and a skill
  there never reached the model). The evidence is in the file header. A symlink into the installed package, so it is only on machines that run the
  daemon and always the running version's own. Linked only once the harness's own config
  directory exists; a real directory by that name is the operator's and is left alone.
  `TALKCODE_NO_SKILL_LINK=1` turns it off — set it on a test daemon run from a checkout, or
  it repoints the live daemon's link at the checkout until the live one next spawns an agent.
- **agy has no tools.** It does not speak ACP, and its MCP servers live in a global config
  (`agy mcp add`) the gateway will not edit — an entry there would appear in the operator's own
  interactive agy too. It gets the skill, whose CLI covers the same two commands.

### `session/load` replay must not reach the chat

Resuming a stored session replays its whole history as ordinary `session/update`
notifications. `promptedYet` suppresses rendering until the first prompt — but on its own
that is a **race**, and losing it re-narrates the entire conversation into the chat
(2026-09-11: five updates suppressed, hours of history re-sent). The flag is written by
`runTurn` just before `prompt()` and read by the pump at dequeue time, with only a few
microtask ticks between them; the reader drops what it reaches and renders the rest.

So the flag now waits on a fence the pump releases (`replayFence`). By the time
`session/load` returns, every replayed notification is already queued — the agent emits
them before answering and one JSON-RPC stream is ordered — so the replay is a finite
buffered prefix, and `readNext` decides "caught up" by racing each read against a
macrotask: `AsyncQueue.next()` answers a buffered read on a microtask, so a `setImmediate`
can only win when the queue is empty. **That is an SDK internal** — see the Hyrum's Law
note on `readNext` and the contract test.

Two rules if you touch this: never start a second `nextUpdate()` while one is outstanding
(the abandoned promise is the one the queue feeds, so its message is lost), and release
the fence in `resetHandles` or a turn parked on a dead child waits forever.

### Asking the user something (ACP elicitation)

The client advertises `clientCapabilities.elicitation.form` at `initialize`, and this is
load-bearing rather than decorative: **claude-agent-acp keeps the model's own
`AskUserQuestion` tool disabled unless it is set** (`disallowedTools = elicitationSupport
.form ? [] : ["AskUserQuestion"]`). Without it a model that needs a decision either picks
for you or asks in prose and ends its turn.

The value must be an **object**, not `true`. ACP types it as `ElicitationFormCapabilities`;
claude reads it as a truthy check so `{}` satisfies it, but opencode validates strictly and
answers `form: true` with `-32602 Invalid params`, which fails `initialize` and takes down
every opencode session — not just its elicitations.

Path: `elicitation/create` → `parseFormElicitation()` (pure; reads the questions back out
of the request's JSON Schema) → `AgentStreamHandlers.onElicit` → TurnRunner's
`onElicitRequest` hook → `daemon.askButtons()`, the same machinery the `ask` reverse
command uses. Anything unrenderable (url mode, no turn open, no tappable options) is
`cancel`led rather than answered, so the model learns the question went unanswered instead
of acting on a choice nobody made.

**A question can also be answered by typing.** claude declares a free-text `question_<n>_custom`
field beside every question (its "Other" box) and prefers it over the enum, so a message typed while
a question is on screen is recorded there — `ElicitQuestion.customKey` carries the key. The
interception lives in `ConversationRegistry.route()`, deliberately placed past the gate and past the
daemon commands but **before the merger**: reaching the merger is the bug. The merger hands a
mid-turn message to the running turn as a new message, and the running turn is the one blocked on
the question; before this interception (when the merger still cancelled the turn instead) typing an
answer to question 2 of 3 killed the form — the first two answers thrown away, the third never
asked, and the reply re-run as a fresh instruction. Not consumed: a message carrying attachments
(the field takes a string), and any question whose form declared no free-text field (sending the
words as the enum value would hand the agent something it never offered). Both go to the merger as
ordinary messages, which no longer cancels the turn — so the way out of a question you cannot
answer is `/stop`.

**A question that takes more than one answer** (`multiSelect`, `type: 'array'` on the wire) is a
stateful bubble rather than a one-tap one: each option carries a checkbox in its own label, a tap
toggles it and repaints the row, and a Done button one index past the options — which is what lets
`onAskClick` tell "finish" from "toggle option n" without a second id grammar — resolves the round
with everything ticked, in the agent's own option order. Done with nothing ticked says so and stays
up, because there is no answer to give and a silent no-op reads as the bot ignoring the tap. All of
that rests on repainting the posted buttons, so it happens only where `capabilities.editButtons` is
true; elsewhere the round degrades to one tap and the body says so, pointing at typing — which
genuinely works, since a typed answer travels under the free-text field the harness prefers anyway.

Questions are retired — buttons cleared, outcome written onto the bubble — on every exit: a tap, a
typed answer, a timeout, `/stop`, `/new`, and any cancel of the turn (`abortTurn`, the one
choke point every cancellation passes through). Leaving one behind is not cosmetic: its buttons stay
live against a request that no longer exists, `hasPendingWork` pins the child until the ask times
out, and the next message would be read as its answer. The clearing goes through `editButtons(ref,
text, [])` rather than a text-only `editMessage` for the reason given at `editModelMenu` — only
Discord and Telegram drop components on a plain edit.

Two things this costs elsewhere: the turn's silence watchdog treats a pending elicitation
as "blocked on a human, not hung" and re-arms instead of aborting (`awaitingUser`), and
option rationales are rendered into the message body because a button label cannot hold a
sentence.

Probed live 2026-09-11: `claude` sends real elicitations; **`opencode` 1.18.27 and `dsh`
0.1.2-rc.1 send none at all** (opencode sends no reverse requests whatsoever, not even
`session/request_permission`). On those two a model that wants to ask writes the question
as text and ends the turn, which the user answers in the next message — a graceful
degradation that needs no code.

## Skills the gateway keeps

`<configDir>/skills/` is a second kind of skill, beside the two the package bundles: one an agent
writes through `talkcode skills` (`skills-store.ts`), delivered to every agent on every host at
spawn (`managed-skills.ts`, and `remote-hosts.ts` `placeManagedSkills` for an agent on another
machine). The copy lives in `~/.talkcode/skills/<name>/` — never under a version directory — and is
read-only; the link into each harness's skill directory is made only when the harness's own config
directory exists, and is repointed or removed only when it points back into that copy. A real
directory, a real file, or the operator's own link at the same name is left alone and logged.

`SKILL.md` is capped at 20 KB and every write is validated (`skills-store.ts`), because the skill
enters every agent's context. `show` prints a content hash; `patch` refuses unless it carries that
hash, so a half-read edit cannot silently undo a newer one. Before each content change the old
files go into `.history/<name>/<id>/` with one `meta.json`, and `revert` restores a whole snapshot
and records the revert itself. `archive` moves the directory into `.archive/`; the next spawn takes the
copy and every link of ours back, and the conversation the skill came from gets one line.

The same store is behind the web UI's skills page (`skills-panel.ts`): the page lists, creates,
edits, archives/restores and reverts through these functions, so its rules are these rules, and an
archive made there calls the same `notifySkillArchived`. It has no hard delete because the store
has none — its Delete is `archive`, and Restore is `restore`.

Use is counted from events the gateway already has (`skill-usage.ts`): a `Skill` tool call naming
the skill, a message starting with `/<name>`, or any tool call whose arguments mention
`~/.talkcode/skills/<name>/`. A turn counts a skill once; `talkcode skills` is management and is
excluded. `skill-lifecycle.ts` sweeps daily: 14 days unused marks expired, 30 archives; a pinned
skill is exempt, and nothing is deleted.

## `daemon.ts` responsibilities

**Outbound pacing is applied once, in the constructor.** `this.platforms` is not the map
the caller passed but a copy in which every adapter is wrapped by
`withOutboundPacing`. That single wrap is what puts the reply, the tool bubbles, the
reactions, the acks, the menus and the agent's own reverse commands on one shared per-chat
budget — the ~38 call sites across `conversation.ts`, `daemon.ts` and `turn-runner.ts`
need no changes, and a path added later is paced by default rather than by remembering.

`stop()` **drains** the pacer before stopping the adapters: a queued write is somebody's
reply, and a lane that happened to be paused at shutdown must not lose it. Bounded by
`outbound.drainMs` so a chat the platform has silenced for minutes cannot hold the
shutdown for the same minutes.

**Slash registration is fixed at startup**, derived from config alone
(`buildRegisteredSpecs`), deliberately *not* the union of what agents report — see
[`core/command-translate.ts`](../core/README.md) for why that union misrouted commands.
Registration is best-effort: a failure is logged, never thrown, since slash is a
convenience over plain text. Duplicate names are deduped defensively (Telegram rejects
the whole `setMyCommands` batch on one duplicate).

**`ask` buttons.** `handleAsk` posts a button message and suspends the IPC response until
a click or timeout (default 1 h, matching `session.idleTimeoutMs`), then returns `{ chosen }` to
the blocked CLI process. An intermediate reminder is posted after 30 minutes if no answer has arrived.
Button ids are `ask:<reqId>:<index>` — the **index**, not the label, because Telegram
caps `callback_data` at 64 bytes and a longer id degrades to a lossy hash. On resolve or
timeout the buttons are stripped and the message annotated. On 1 h timeout, the resident agent
child process is automatically reclaimed to free system resources (either immediately if idle, or as
soon as the turn settles). When the user later responds, the session is resumed seamlessly via
ACP `session/load` or agy `--conversation`. On shutdown every pending ask is resolved `null` so no
caller hangs forever. While pending, an ask also holds its conversation against idle reclaim
(`hasPendingWork`) until the ask timeout fires.

**Harness pickers** — the bare form of an agent command (`/cc`, `/oc`) — post the agent's
*reported* commands as buttons, never a guessed list. Names already reachable through the
generic vocabulary are filtered out. Buttons are capped at 25 (Discord's
components-per-message limit; the `claude` harness reports ~39, so this is reached in
practice) and the remainder is **listed as text, not dropped**. A click is delivered
straight back to the recorded conversation via `dispatchTo` — re-routing a bare `/init`
would resolve it against the pipeline instead of the conversation's bound agent, landing
on whichever agent config prefers rather than the one whose menu offered it. The clicker
is re-checked against the allowlist, because a button in a shared channel can be pressed
by someone other than the person who opened the menu. A harness that reports no list
(`agy`) acks the binding instead — see `HARNESS_COMMANDS` in
[`core/command-translate.ts`](../core/README.md).

Two things about a click are worth stating, because every way this path could fail used
to be a silent `return` — indistinguishable, from the chat, from a dead button:

- **The ack edits the MENU message**, whose ref is captured from the send, not the click
  event's `messageId`. `ButtonInteraction.messageId` is contractually the message the
  button is on, but Telegram's Satori adapter puts the `callback_query` id there — not a
  message id at all — so editing it 400s and the caller swallows it. That was the whole
  visible feedback for a click, and it never applied. The Telegram profile now corrects
  the field at the source too (`rawCallbackMessageId`), which also restores the 👀/✅
  lifecycle reactions on the resulting turn.
- **An expired menu says so.** `pendingPicks` is in-memory and one-shot, so a second click
  or a click after a daemon restart finds nothing — and used to answer nothing.

**The model menu** — a bare `/model` where the platform can post buttons *and* replace them
(`capabilities.editButtons`). The registry decides who the menu is for and hands over the
live selector; `daemon.ts` posts it, pages it and acks it. Three things it does differently
from the harness picker, each for a reason:

- **It is not one-shot.** Paging is the point, so a page click leaves the entry in place;
  only a successful pick (or a `gone`/`rebound`/`missing` outcome) retires it.
- **At most one live menu per conversation.** Opening a new one retires the old *in place*,
  saying so on the message rather than leaving live-looking buttons behind. That is what
  bounds `pendingModelMenus` — by live conversations, which `access.allowFrom` already
  bounds — with no TTL (which would expire a menu still on screen because a clock ran out)
  and no LRU (which would let one user's traffic kill another's open menu).
- **The option list is frozen at open, and the resolved VALUE is re-checked at click.** A
  pick id carries an absolute index into that snapshot; the page a button targets lives in
  its id too, so the daemon holds no page cursor that could disagree with the screen. The
  harness can rebuild its list mid-session, and without the value re-check a stale index
  would switch to a model the user never saw — the one path here that could be silently
  wrong. `ConversationRegistry.applyModelChoice` does that check, along with "conversation
  still exists", "same agent still bound", and "there is a live selector at all".

The pure half — paging, labels, ids, matching, and every string either surface says — is
[`core/model-menu.ts`](../core/README.md), so the menu and `/model <query>` cannot answer
differently.

**The settings menu** — `/setting`, on the same capability test as the model menu, and built
on the same three rules (not one-shot, at most one per conversation, frozen snapshot +
re-read value). Two levels in one message: the row list, and one setting's values. It differs
from the model menu in what a pick does and what it costs:

- **A successful write returns to the LIST**, with the ack above it and the changed row
  showing its new value. Changing two settings in a row is the normal case, so the screen
  keeps working instead of retiring. Anything that did *not* write stays on the value level.
- **The clicker is re-checked against `access.allowFrom`** — as on every menu, but here the
  click does not merely change who answers a conversation: it edits the operator's
  config.yaml. (Where the allowlist is empty nothing new is granted either — agents already
  run with full tool access, so anyone who can message the bot can edit that file directly.
  See [security invariant #1](../../AGENTS.md#security-invariants).)
- **Row identity comes from the frozen list; the value is re-read every redraw.** So a menu
  left open across a change from the other surface shows the current value, while a button
  still means the setting it was drawn for.

`ConversationRegistry` owns the writing (`applySetting`, `settingRows`, `settingOptionsFor`)
for the same reason it owns `applyModelChoice`: it holds the `Config` that has to be mutated
and the sessions whose model list validates a value. `daemon.ts` owns the buttons. The pure
half is [`core/settings.ts`](../core/README.md); the file itself is written by
`settings-store.ts` (below).

## `settings-store.ts`

Six steps, in a fixed order: parse the value (core), skip a no-op write, **validate a whole
candidate config**, resolve the on-disk path, patch the file, apply in memory.

Step three earns its keep on its own. `/setting` writes the file the daemon needs in order to
*start*, from a chat message — so a value that parses but fails `ConfigSchema.superRefine`
would leave a deployment that runs until someone restarts it and then refuses to. Validating
a candidate copy first turns that into a refusal in chat. Nothing throws: every failure
becomes a `SettingApplyResult`, because one of the two callers is a button click with nobody
to re-prompt.

Two details that are easy to get wrong:

- **The `agents[]` index is resolved against the FILE**, not the runtime array
  (`readRawConfigIfExists`). If anyone reordered `agents:` by hand since startup, patching by
  the in-memory index would set the wrong agent's model — silently, which is the worst
  outcome available here.
- **Clearing a value deletes the key**, it does not write `null`. `agents[].model` is
  `z.string().optional()`, so a `null` would fail the very next `loadConfig` — a write that
  bricks the file it was clearing. `saveConfigPatch` treats `value: undefined` as a delete
  for exactly this.
- **A pod's agent is written to `podModels`**, not `agents[]` — config.yaml does not define it
  (config/pods.ts). The row knows it is a pod's (`SettingRow.pod`, from `podAgentModels` over
  pods.json), so the location is `['podModels', '<id>@<host>']`, "already set" compares with the
  gateway's own entry rather than the merged model, and clearing applies the pod's model to the
  live definition — what the next `readConfig` would compute. Clearing the last entry removes the
  map rather than leaving `podModels: {}`.

### Any agent's model list (`model-catalog.ts`)

A model row's list used to exist only for the agent answering the conversation `/setting` was typed
in, and only once it had replied — a list is part of a live ACP session, and a conversation has at
most one. `ModelCatalog` answers for any agent: a live session of that agent in any conversation,
else what an earlier answer said (kept against the definition object, so a `/reload` that replaces
it asks again), else a session brought up under `models:<agent id>` just to read its selector and
disposed straight after, with its store entry and token. Never the conversation's own session:
warming that would record a session id there and close a new web UI topic's choice of agent
(`agentCatalogForRef`). The ask runs while the screen says so; `daemon.ts` `whenModelsArrive`
redraws the same level when it settles, if the menu is still on that row. A failure is shown and
asked again on the next opening, not on the redraw.

Only the single scalar the user chose is patched, through the yaml Document API, so comments,
key order, hand-edited siblings and `${VAR}` templates all survive byte-identical — the
validated candidate, which holds *expanded* values, never reaches disk. See
[security invariant #4](../../AGENTS.md#security-invariants).

**Inbound dedup.** On platforms where a slash *is* a normal message (Telegram), one
`/cmd` fires both a message event and a command event with the same `messageId`; they are
deduped by `platform:<address>:messageId` within 15 s. When `messageId` is empty (Slack
slash) dedup is skipped — distinct events would collide on the empty-string key, and
those platforms have no double-fire anyway.

**`lastResolvedConversationId`** is a scratch slot written by `resolveAddress` and read by
`handleReverse`, because IPC's `handle(action, address)` signature omits the conversation
id. It is safe **only** because there is no `await` between the two within one dispatch.
The constraint is documented at the field; if you add an await there, you break it.

**Graceful shutdown** runs once (signals repeat on double Ctrl-C): remove signal
handlers, stop IPC, stop every adapter, clear pending asks/picks, dispose the registry.
Exit codes follow shell convention (SIGINT 130, SIGTERM 143). Without this, resident
child processes are orphaned and the socket file lingers.

## Security-critical files

**`attachment-io.ts`** does the real IO behind `core/attachment-ingest.ts`, and its
guards are the reason for the split. Inbound attachment URLs are user-controlled, so
`assertSafeAttachmentUrl` validates the scheme and rejects internal, loopback, and
cloud-metadata targets — and because a `3xx` `Location` can bounce a public CDN URL to an
internal address that the initial check passed, redirects are followed **manually** with
every hop re-validated (`redirect: 'manual'`, capped at `MAX_ATTACHMENT_REDIRECTS`).
Downloads early-exit on a `content-length` over the cap. Saved filenames are sanitized
against traversal and prefixed with a short hash to avoid overwrite. Coverage thresholds
are set on this file's pure guards specifically (`vitest.config.ts`).

One URL class never reaches those guards: a platform that declares `fetchAttachment` gets first
refusal on each URL, and Lark's `internal:lark/…` resource addresses are fetched through the
bot's own authenticated client instead (nothing else *can* fetch them — the guard rejects the
scheme, which is why a Feishu image used to arrive as "failed to download"). That is not a hole
in the SSRF model: those requests go to the vendor endpoint the operator configured, with the
bot's token, and the only user-controlled part is a path segment the profile validates against
Feishu's id alphabet. The size cap still applies and is enforced after the fetch, since that
route reports no `content-length` to pre-check.

**`conversation-token-registry.ts`** compares tokens with `timingSafeEqual` against each
registered token rather than a `Map.get`, so a timing side-channel cannot reveal how many
leading characters of a guess are correct. Defense in depth — tokens are 122-bit UUIDs
and the socket is `0600` — but cheap, since the live set is small.

**`reverse-cli-shim.ts`** guarantees the skill's promise that `talkcode` is on PATH.
Whether it actually is depends on how the daemon was launched: a global npm install puts
it there, `node dist/cli.js start` or a `tsx` dev run does not, and a service manager may
strip PATH entirely. So the daemon writes a two-line shim re-executing *exactly* the
runtime it is itself running as (`execPath` + `execArgv` + `argv[1]`) and prepends the
shim dir to each child's PATH. This also pins the agent to *this* daemon's version when a
different global one exists. POSIX only; on win32 it returns `null` and the agent falls
back to whatever PATH offers.

## Tests

Eighteen test files. `agent-acp.test.ts` and `agent-agy.test.ts` cover protocol
translation; `routing.test.ts`, `command-routing.test.ts`, `session-control.test.ts`,
`session-reclaim.test.ts`,
`conversation-store.test.ts`, `conversation-token-registry.test.ts`,
`multi-platform.test.ts`, `slash-register.test.ts`, `ask-button.test.ts`,
`picker-click.test.ts`, `model-menu-click.test.ts`, `settings-command.test.ts`,
`local-commands.test.ts`, `agy-cli-command.test.ts`, `agy-statusline.test.ts`, `agy-meters.test.ts`,
`permission.test.ts`, `attachment-io.test.ts`, `voice.test.ts` and `voice-routing.test.ts` cover
the rest.

Two of those are worth knowing about before you touch the agy harness.
`agy-cli-command.test.ts` is written as negative assertions — each case asserts that a
name agy's CLI owns did NOT become a prompt, because the failure it guards is a dead
session rather than a wrong answer. `agy-statusline.test.ts` executes the shim this
daemon actually installs, feeding it a frame captured verbatim from agy 1.2.0 and
reading the numbers back the way the runtime does, so a rewrite of that generated script
cannot pass by being plausible.

`settings-command.test.ts` is the only suite here that asserts against a real file on disk
(`TALKCODE_CONFIG_FILE` pointed at a tmp dir), and deliberately so: its most valuable
assertions are that a refusal leaves the file byte-identical, that clearing deletes a key
rather than writing a `null`, that a `${VAR}` template is never expanded on the way through,
and that `loadConfig()` still succeeds afterwards. Each of those, if it broke, would produce
a deployment that runs fine until someone restarts it.

`session-reclaim.test.ts` is written almost entirely as negative assertions, for the same
reason the click suites are: every gate that fails open produces an agent that silently
forgot a task, and none of them announce themselves.

Two suites are load-bearing for the design rather than for a function:
`command-routing.test.ts`'s *sticky agent binding* block reproduces the reported bug
(`/oc hi` then a plain follow-up must stay with opencode, in one conversation), and
`conversation-store.test.ts` pins the "agent owns its context" invariant — bind, switch
away, switch back, and the first agent's own session id is still there. A third,
`model-menu-click.test.ts`, exists for the same reason `picker-click.test.ts` does: on a
button, a silent `return` is indistinguishable from a dead button, so every way a click can
fail has a test asserting it produces words.

`daemon.ts` and `turn-runner.ts` have no direct test file — their pure helpers are
exported and tested from the files above (`parseAskButtonId`, `parsePickButtonId`,
`agentCommandToSpec`, `buildRegisteredSpecs`). When adding logic to either, extract the
decision as a pure exported function and test it there; that is the established pattern.
