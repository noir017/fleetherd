# 语音消息

[English](../voice.md) | 简体中文

发一条语音（或者不带说明文字的音频文件，或在网页端点 🎤 录音），网关会先把它转成文字，
再整理成你想表达的那条消息，在交给智能体之前把两份都给你看：

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

整理稿会去掉口头禅、重复和结巴，按你的改口取最后的说法（「部署到 A，不对，B」只留 B），
纠正听错的名字——但不会为了精简删掉要求，也不会加你没说的内容。它只根据转写出的文字来写，
是转写之后对同一个模型的第二次请求，不接触录音，所以编不出你没说过的话。没什么可整理时卡片
和以前一样只显示一份；整理失败时显示原话，并写明原因。

点 ✅ Send 后，这段文字就像你亲手打的一样交给智能体——智能体不会被告知这是语音。
直接打字会替换掉这条识别结果；`/stop`、`/new` 会撤销它；30 分钟没人点就过期。
卡片处理完后 🎙️ 标记一直保留，往回翻就能看出哪些消息来自语音、有没有发出去。

```yaml
voice:
  confirm: true                           # false = 识别完直接发给智能体
  cleanup: true                           # false = 只要逐字转写
  vocabulary: [Unraid, OpenWrt]           # 你常说、希望它写对的名字
  transcriber:                            # Gemini 的 generateContent 格式
    baseUrl: https://generativelanguage.googleapis.com/v1beta   # 或 new-api 网关：http://newapi:3000/v1beta
    apiKey: ${GEMINI_API_KEY}
    model: gemini-3-flash
```

- 识别质量信得过以后，在聊天里 `/setting voice off` 即可关掉确认，立即生效——此后自动发出的是整理稿。
  `/setting cleanup off` 回到逐字转写。
- `vocabulary` 会加在内置词表（fleetherd、Claude Code、Codex……）后面：填你的主机名、服务名这类
  语音识别只能按发音瞎写的词。转写和整理两次请求都会用到它。
- 整理每条语音多花一次请求。如果用的是有每日次数上限的免费档（Google AI Studio 按 key、按模型计），
  上限能覆盖的语音条数会减半。
- **带**说明文字的音频不转写：「帮我剪一下」加一个 mp3 是针对文件的指令，文件照旧交给智能体。
- 支持 Ogg、WebM、MP4/M4A、MP3、WAV、AAC、FLAC。QQ 和企业微信的语音编码（SILK、AMR）不支持，会明确告诉你。
- 每次转写都记录在 `~/.config/fleetherd/voice-log.jsonl`，附带保存的音频文件和两份文字；
  智能体觉得某句话像是听错了时，可以用 `fleetherd voice-log` 查本会话的转写记录。
- 不能显示按钮的平台（QQ、LINE、企业微信、钉钉）会自动发送，卡片上会写明原因。
- 不配 `voice:` 时，语音就是普通附件，和以前一样。
