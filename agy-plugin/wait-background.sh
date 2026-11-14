#!/bin/sh
# agy Stop hook, shipped by fleetherd (src/daemon/agy-plugin.ts says why it exists).
#
# Under `agy acp`, a turn ends while a command it put in the background is still running, and what
# agy does when that command finishes never reaches the chat. This keeps the turn open instead,
# silently: when the model is done and a background task is still running, it waits until agy's
# mailbox has something new (the task finishing, or a message the person sent) and lets the loop
# continue, so agy reads it inside the same turn. It writes nothing for the model to read.
#
# stdin: agy's Stop payload. stdout: {} lets the turn end; {"decision":"continue"} keeps it going.

# FLEETHERD_AGY_WAIT_LOG names a file to trace decisions into, for diagnosis; unset, nothing is written.
log() { [ -z "${FLEETHERD_AGY_WAIT_LOG:-}" ] || echo "$(date +%T) ${conv:-?} $*" >>"$FLEETHERD_AGY_WAIT_LOG"; }
allow() { log "end ($1)"; echo '{}'; exit 0; }
resume() { log "continue ($1)"; echo '{"decision":"continue"}'; exit 0; }

input=$(cat)

# Only inside a conversation the gateway runs: an interactive agy waits for its tasks on its own.
[ -n "${FLEETHERD_TURN_TOKEN:-}" ] || allow "not a gateway session"
field() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p"; }

# A cancel, an error or a spent budget ends the turn as agy decided.
[ "$(field terminationReason)" = NO_TOOL_CALL ] || allow "$(field terminationReason)"

# The mailbox sits beside the transcript: brain/<conversation>/.system_generated/{logs,messages}.
conv=$(field conversationId)
transcript=$(field transcriptPath)
if [ -n "$transcript" ]; then
  box=$(dirname "$(dirname "$transcript")")/messages
else
  box=$HOME/.gemini/antigravity-cli/brain/$conv/.system_generated/messages
fi

# Messages already acted on, so one agy leaves unread can never keep re-opening turns.
seen=${TMPDIR:-/tmp}/fleetherd-agy-wait.$(id -u).$conv

# Whether the mailbox holds something the loop should wake for: a high-priority message (a task
# finishing, the person writing) that agy has not read and this hook has not already acted on.
wake() {
  found=1
  readids=$(cat "$box/read.json" 2>/dev/null)
  for f in "$box"/*.json; do
    [ -e "$f" ] || continue
    id=${f##*/}
    id=${id%.json}
    [ "$id" = read ] && continue
    case $readids in *"\"$id\""*) continue ;; esac
    grep -qx "$id" "$seen" 2>/dev/null && continue
    grep -Eq '"priority"[[:space:]]*:[[:space:]]*"MESSAGE_PRIORITY_HIGH"' "$f" || continue
    echo "$id" >>"$seen"
    found=0
  done
  return $found
}

# Keep only what agy has still not read; with nothing left the file goes, so a conversation whose
# messages were all read leaves nothing behind.
prune() {
  [ -f "$seen" ] || return 0
  readids=$(cat "$box/read.json" 2>/dev/null)
  keep=$(while IFS= read -r id; do
    case $readids in *"\"$id\""*) ;; *) [ -e "$box/$id.json" ] && echo "$id" ;; esac
  done <"$seen")
  if [ -n "$keep" ]; then printf '%s\n' "$keep" >"$seen"; else rm -f "$seen"; fi
}

# A task that finished just as the model stopped: its message is already waiting.
wake && resume "already waiting"

# Nothing running in the background: the turn is over.
if ! printf '%s' "$input" | grep -Eq '"fullyIdle"[[:space:]]*:[[:space:]]*false'; then
  prune
  allow "nothing in the background"
fi

# agy runs the hook through `sh -c`; the process to outlive is whichever of the two is agy.
agy=$PPID
[ "$(cat /proc/$agy/comm 2>/dev/null)" = sh ] && agy=$(awk '{print $4}' /proc/$agy/stat 2>/dev/null)
log "waiting (agy pid ${agy:-unknown}: $(cat /proc/$agy/comm 2>/dev/null))"

# How long to wait before letting the model take a turn anyway. The gateway fails a turn that is
# silent for longer than its watchdog allows (agy-plugin.ts AGY_WAIT_WINDOW_S says how long that
# is); a turn that speaks starts the count again. hooks.json's timeout must stay above this.
window=${FLEETHERD_AGY_WAIT_WINDOW_S:-1200}

count() { set -- "$box"/*.json; [ -e "$1" ] && echo $# || echo 0; }
last=$(count)
waited=0
while [ "$waited" -lt "$window" ]; do
  sleep 1
  waited=$((waited + 1))
  [ -z "$agy" ] || kill -0 "$agy" 2>/dev/null || allow "agy is gone"
  now=$(count)
  if [ "$now" != "$last" ]; then
    last=$now
    wake && resume "after ${waited}s"
  fi
done
resume "nothing new in ${window}s"
