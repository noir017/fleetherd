# Voice messages

English | [简体中文](zh-CN/voice.md)

Send a voice note — or an audio file with no caption, or tap 🎤 in the web UI —
and the gateway transcribes it, writes it up as the message you meant, and
shows you both before anything reaches the agent:

```
🎙️ Voice transcript · gemini-3-flash · 6.1s

✍️ Cleaned up:
1. 给本项目的 CI/CD 添加一个编译项，编译成 Docker 镜像。
2. 把它作为服务部署到我的 Unraid 服务器上。
3. 在 OpenWrt 上配置一下域名。

🗣️ As spoken:
给本项目的CICD添加一个编译项，编译成Docker容器，Docker镜像。然后，把那个 把把它部署成服务，部署到我的那个Unraid的服务器上，然后，然后在那个OpenWrt上配置一下域名。

Send the cleaned-up version to the agent? Tap ✅ Send, or 🗣️ Send as spoken for the words as heard — or type your own, and this one is dropped.
[✅ Send] [🗣️ Send as spoken] [✖ Cancel]
```

The cleaned-up version drops fillers, repeats and stutters, applies your
corrections ("deploy it to A — no, B" keeps B), and fixes names it misheard —
without summarizing anything away or adding anything you did not say. It is
written from the transcript alone, in a second request to the same model after
the transcription; it never hears the audio, so it cannot invent what you said.
When there is nothing to clean up the card shows one text, as before; when the
cleanup fails, the card shows the words as heard and says why.

✅ Send hands the words on exactly as if you had typed them — the agent is not
told they were spoken. Typing instead replaces the transcript; `/stop` and
`/new` call it off; an untouched card expires after 30 minutes. Every card keeps
its 🎙️ label after it is settled, so scrolling back always shows which messages
came from your voice and whether they were sent.

```yaml
voice:
  confirm: true                           # false = send each transcript on at once
  cleanup: true                           # false = the word-for-word transcript only
  vocabulary: [Unraid, OpenWrt]           # names you say that it should spell right
  transcriber:                            # Gemini's generateContent format
    baseUrl: https://generativelanguage.googleapis.com/v1beta   # or a new-api gateway: http://newapi:3000/v1beta
    apiKey: ${GEMINI_API_KEY}
    model: gemini-3-flash
```

- Once transcripts have earned your trust, `/setting voice off` turns
  confirmation off from chat, live — the cleaned-up version is what is then
  sent. `/setting cleanup off` goes back to word-for-word transcripts.
- `vocabulary` is added to a built-in list (fleetherd, Claude Code, Codex, …):
  the names of your hosts and services, which speech recognition otherwise
  spells by ear. Both requests are given it.
- Cleanup costs a second request per voice message. On a free tier with a
  daily request cap (Google AI Studio's is per key and per model), that halves
  how many voice messages the cap covers.
- Audio **with** a caption is left alone: "trim this" plus an mp3 is an
  instruction about a file, so the file goes to the agent as before.
- Ogg, WebM, MP4/M4A, MP3, WAV, AAC and FLAC are transcribed. QQ's and WeCom's
  voice codecs (SILK, AMR) are not — you are told so.
- Every transcription is logged to `~/.config/fleetherd/voice-log.jsonl`
  with its saved audio file and both versions, and the agent can look its
  conversation's transcripts up with `fleetherd voice-log` when a message reads
  like a mishearing.
- Platforms that cannot show buttons (QQ, LINE, WeCom, DingTalk) send on
  automatically, and the card says why.
- Leave `voice:` out and a voice note is an ordinary attachment, as before.
