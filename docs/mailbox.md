# Agents that only poll (mailbox)

Some agents cannot be called. Meta's Muse runs in a cloud VM of its own: it can run a script every
few seconds and make HTTPS requests, and that is all. `fleetherd api-agent mailbox` reaches such an
agent through a mailbox relay that both sides poll, so neither the agent nor the gateway accepts a
connection.

```
fleetherd ──ACP──► api-agent mailbox ──HTTPS──► agent-mailbox relay ◄──polls every 5–30 s── Muse
```

The relay is [agent-mailbox](https://github.com/noir017/agent-mailbox), a Cloudflare Worker that
fits the free plan. Muse polls every 5 seconds while messages are going back and forth and every
30 after an idle hour, so an idle account costs 2,880 requests a day out of 100,000 (the arithmetic
is in its README). Its
`integrations/muse/` is what goes into Muse: a connector, a hook and the rules Muse follows.

## Setup

1. Deploy the relay and make one mailbox per Muse account (`npm run new-mailbox -- <id>`). Each
   mailbox has an agent token (for Muse) and a client token (for the gateway).
2. Install the Muse package in that account, following `integrations/muse/README.md`.
3. One agent entry per mailbox:

```yaml
agents:
  - id: muse
    harness: custom
    command: fleetherd
    args: [api-agent, mailbox, --url, "https://mailbox.example.com"]
    env: { MAILBOX_TOKEN: "${MUSE_MAILBOX_TOKEN}" }
  - id: muse-work                 # a second account: its own mailbox and token
    harness: custom
    command: fleetherd
    args: [api-agent, mailbox, --url, "https://mailbox.example.com"]
    env: { MAILBOX_TOKEN: "${MUSE_WORK_MAILBOX_TOKEN}" }
```

The URL can also come from `MAILBOX_URL`. The token is read from `MAILBOX_TOKEN` only — an argument
would show in `ps` and sit in config.yaml as written. It runs on the gateway's own machine (no
`host:`). There is no model menu.

## What a turn looks like

- Your message goes into the mailbox; Muse picks it up within a few seconds (up to 30 after an idle
  hour) and sends a progress
  line, shown as a row: `progress: "…"`. Each new one closes the last with its duration.
- Its answer is the reply. Muse ends every turn with a final, which ends the turn here.
- Each conversation is a session of its own, but on Muse's side every session is woken into its
  one main conversation, which is the context: Muse keeps sessions apart there by their id, and
  the gateway adds nothing to what it reads. One conversation per Muse account at a time works
  best. `/new` starts a fresh session; a gateway restart keeps it.
- **Nobody picks the message up in 2 minutes**: the message is withdrawn and the turn fails with
  when the agent last polled — usually the hook is off or the account is out of quota.
- **Nothing more for 5 minutes after pickup**: the turn ends with what arrived and a note that no
  completion mark came. 5 minutes is under the gateway's 10-minute silence watchdog, so this note
  comes first.
- **`/stop`**: a message not yet picked up is withdrawn and Muse never sees it; otherwise Muse is
  sent a cancel. Its confirmation arrives as a follow-up.
- **Later replies** — an answer after the turn ended, or something Muse sends on its own — appear as
  a `⏱ background update` while the agent process runs (it polls every 20 seconds between turns).
  When it does not (reclaimed when idle, or the gateway restarted), they wait in the relay and open
  the next reply under `⏱ Earlier replies not shown yet`.

`--pickup-timeout <s>` and `--silence-timeout <s>` change the two limits; the second must stay
under 600.

## Limits

- Text only. Pictures and files are not sent; the reply says so, and if a message was only
  attachments nothing goes out.
- No model menu, local files, `send_file`/`schedule`, MCP or skills on the gateway's side, and no
  mid-turn steering.
- `/stop` is a request: Muse stops at its next step.
- The relay's daily quota is shared: each account polls 2,880 times a day when idle and 17,280 when in
  use all day, and the gateway adds a
  poll every 2 seconds in a turn and every 20 seconds between turns while a conversation's process
  lives.
