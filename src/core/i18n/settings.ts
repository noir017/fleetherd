import { createTranslator, type DictOf } from './index.js';

export const en = {
  // Permission levels
  'level.plan.detail': 'it plans before it acts, and whatever it asks to do waits for your OK',
  'level.ask.detail': 'edits and commands wait for your OK',
  'level.edits.detail': 'edits in its working directory go through; commands wait for your OK',
  'level.auto.detail': 'whatever it asks to do is approved',
  'level.full.detail': 'its no-prompt mode: nothing is asked, and no sandbox',
  'level.apiAgent.detail': 'calls a cloud API and runs nothing on this machine',
  'level.ask.agyDetail': 'edits go through; commands wait for your OK',
  'level.ask.noModeDetail': 'whatever requests it makes wait for your OK',

  // Setting row labels
  'row.agent.label': 'Default agent',
  'row.model.label': 'Default model · {target}',
  'row.permissions.label': 'Permissions · {target}',
  'row.delegation.label': 'Confirm sub-agent starts',
  'row.idle.label': 'Idle reclaim',
  'row.scope.label': 'Conversation scope',
  'row.stream.label': 'Live streaming',
  'row.voice.label': 'Confirm voice transcripts',
  'row.cleanup.label': 'Clean up voice transcripts',
  'row.reviewAgent.label': 'Auto review',
  'row.reviewModel.label': 'Review model',
  'row.locale.label': 'Language',

  // Group names and notes
  'group.agents': 'Agents',
  'group.subagents': 'Sub-agents',
  'group.conversations': 'Conversations',
  'group.replies': 'Replies',
  'group.voice': 'Voice',
  'group.reviews': 'Reviews',
  'group.general': 'General',
  'group.more': 'More',
  'group.note.agents':
    'Each agent’s own settings. A model applies from its next session (`/new`), `/model` changes one topic only; a permission level applies at once.',
  'group.note.reviews':
    'An agent reads a conversation that has gone quiet and writes what it learned into the skill library. The review runs with its tools switched off and every permission refused.',

  // Screen headers & field labels
  'screen.about':
    'These apply to every conversation. A change applies at once unless its row says when; `/model` and `/agent` change one topic only.',
  'field.model': 'Model',
  'field.permissions': 'Permissions',

  // Setting descriptions
  'desc.agent': 'Which agent answers when no routing rule matches.',
  'desc.model':
    'The model `{target}` starts its sessions with. `/model` still overrides it for one conversation.',
  'desc.permissions':
    'How much `{target}` may do without you. Each level sets the mode its harness runs in ' +
    'and whether what it asks to do waits for your OK: `plan`, `ask` and `edits` put each request ' +
    'to you as buttons — one nobody answers is declined, never approved; `auto` and `full` approve. ' +
    'Only the levels its harness has a mode for are offered. A change applies at once: a running ' +
    'session is switched to the new mode, and its next request is answered the new way.',
  'desc.delegation':
    'When `task-new` waits for you to tap Start on a card listing every sub-task: always ' +
    '(`on`, the default), once per agent in each conversation (`first`), or never (`off`, ' +
    'which starts each one at once and posts a card showing what started). `first` remembers ' +
    'only in memory, so a restart or another conversation asks again. `first` and `off` reach ' +
    'only conversations you talk to directly; a sub-agent\'s own topic still asks. Only you ' +
    'can change this; no agent command reaches it.',
  'desc.idle':
    'How long a conversation may sit quiet before its agent child is stopped. It resumes on the next message.',
  'desc.scope':
    'What counts as one conversation — a thread, a channel, a person, or the whole deployment.',
  'desc.stream':
    'Whether a reply is typed out by editing one message as it arrives (`on`), or sent whole once ' +
    'each part is finished (`off`, the default). Off costs no edits, so a long reply can never run ' +
    'into a platform’s per-message edit cap; either way a segment is sent at every tool boundary.',
  'desc.voice':
    'Whether a voice message’s transcript waits for your ✅ Send (`on`, the default) or goes to the ' +
    'agent at once (`off`). Either way the transcript is shown in the chat, labelled as one.',
  'desc.cleanup':
    'Whether a voice message is also written up as the message you meant — fillers, repeats and ' +
    'self-corrections removed — and shown above the words as heard, with ✅ Send sending that ' +
    'version (`on`, the default); or transcribed word for word only (`off`).',
  'desc.reviewAgent':
    'Which agent reviews conversations that go quiet and writes what it learned into the skill ' +
    'library. Any agent can: a review runs on its machine with its tools switched off where the ' +
    'harness allows it and every permission refused. `off` turns auto review off; naming an agent ' +
    'replaces a `review.api` endpoint. The next sweep reads the new value — within a minute.',
  'desc.reviewModel':
    'The model reviews run with. Unset follows the reviewer’s own model; pick one here to give ' +
    'reviews a different model from the agent’s. A `review.api` endpoint names its own model in ' +
    'config.yaml. A change lands on the next sweep.',
  'desc.locale':
    'Language used for settings, system notifications and the Web UI.',

  // Setting hints
  'hint.agent': 'Answers a new conversation that no routing rule claims.',
  'hint.delegation':
    'Wait for your Start before an agent’s sub-tasks run. `first` asks once per agent in each conversation; `off` starts them at once. A sub-agent’s own topic still asks.',
  'hint.idle': 'Stop an agent that has been quiet this long. Its conversation resumes on the next message.',
  'hint.scope': 'What counts as one conversation: a topic, a channel, a person, or the whole gateway.',
  'hint.stream': 'Type each reply out as it arrives, instead of sending each part once it is finished.',
  'hint.voice': 'Hold a voice message’s transcript until you tap ✅ Send.',
  'hint.cleanup': 'Also write a voice message up as the message you meant, and send that version.',
  'hint.reviewAgent':
    'Have an agent review a quiet conversation and write what it learned into the skill library. Off by default.',
  'hint.reviewModel': 'The model reviews run with. Unset follows the reviewer’s own model.',
  'hint.locale': 'Interface language for settings and Web UI.',

  // Effects
  'effect.live.text': 'in effect now',
  'effect.live.sentence': 'Takes effect at once.',
  'effect.nextSession.label': 'next session',
  'effect.nextSession.text': 'applies to {target}’s next agent session — /new starts one now',
  'effect.nextSession.sentence': 'Takes effect from {target}’s next agent session — `/new` starts one now.',
  'effect.restart.label': 'after restart',
  'effect.restart.text':
    'takes effect when the daemon restarts; conversations keep their current identity until then',
  'effect.restart.sentence':
    'Takes effect when the daemon restarts; conversations keep their current identity until then.',

  // Unset and sources
  'unset.model': 'harness default',
  'unset.modelParen': '(harness default)',
  'unset.reviewModel': "agent's own",
  'unset.permissionSession': 'not set · from a running session’s mode',
  'unset.permissionPin': 'not set · from its pinned mode',
  'unset.permissionNone': 'not set',
  'source.gateway': 'set here',
  'source.pod': 'pod.yaml',

  // Options
  'option.delegation.on': 'on — wait for Start before any sub-task runs',
  'option.delegation.onDetail': 'wait for Start before any sub-task runs',
  'option.delegation.first': 'first — wait for Start once per agent in each conversation',
  'option.delegation.firstDetail': 'wait for Start once per agent in each conversation',
  'option.delegation.off': 'off — start each sub-task at once, and post a card for the record',
  'option.delegation.offDetail': 'start each sub-task at once, and post a card for the record',
  'option.stream.off': 'off — send each finished part as a whole message',
  'option.stream.offDetail': 'send each finished part as a whole message',
  'option.stream.on': 'on — type the reply out by editing one message',
  'option.stream.onDetail': 'type the reply out by editing one message',
  'option.voice.on': 'on — wait for ✅ Send before the agent sees it',
  'option.voice.onDetail': 'wait for ✅ Send before the agent sees it',
  'option.voice.off': 'off — send each transcript on at once',
  'option.voice.offDetail': 'send each transcript on at once',
  'option.cleanup.on': 'on — show a cleaned-up version too, and send that',
  'option.cleanup.onDetail': 'show a cleaned-up version too, and send that',
  'option.cleanup.off': 'off — word for word only',
  'option.cleanup.offDetail': 'word for word only',
  'option.review.off': 'off — no automatic reviews',
  'option.review.offDetail': 'no automatic reviews',
  'option.idle.never': 'off (never reclaim)',
  'option.idle.neverDetail': 'never reclaim',
  'option.scope.perThread': 'a topic / thread is its own conversation',
  'option.scope.perChannel': 'every lane of a channel shares one',
  'option.scope.perUser': 'one conversation per person, anywhere',
  'option.scope.shared': 'one conversation for the whole deployment',

  // Menu, acks & notices
  'menu.head': 'Settings — saved to config.yaml, not just this conversation. Tap one to change it.',
  'menu.overflow': '{count} more (type them): {keys}',
  'menu.prev': '◀ Prev',
  'menu.next': 'Next ▶',
  'menu.back': '◀ Back',
  'menu.expired':
    'That settings menu has expired (superseded, or the gateway restarted). Run /setting again for a fresh one.',
  'menu.superseded': 'Settings — superseded by a newer /setting menu.',
  'menu.typeModelPlaceholder': 'Or type a model name',
  'menu.pageNav': 'page {page}/{total}',
  'ack.saved': 'Saved {label} = `{display}` ({effect}).',
  'ack.overridden':
    'This topic has a `/model` override in force, so it keeps using `{model}` until `/model default` or `/new`.',
  'ack.unchanged': '{label} is already `{value}`.',
  'notice.unknownKey': 'No setting called `{key}`. Configured settings:\n{keys}',
  'notice.typedOnly': 'Type a value for this setting: `/setting {key} <value>`.',
  'notice.typedOnlyNoLive':
    'Type a model name for this agent: `/setting {key} <model>` (it offered no live list to pick from).',
  'notice.refused':
    '`{key}` is not editable from chat — {group} stays in the file, because {reason}.\n{action}',
  'notice.editRestart': 'Edit config.yaml and restart the daemon.',
  'notice.editReload': 'Edit config.yaml, then send /reload.',
  'notice.noAgentNamed': 'No agent named there. Configured agents: {agents}.',

  // Push notifications
  'push.waitingAnswer': 'Waiting on your answer',
  'push.failed': 'Failed',
  'push.finished': 'Finished',
} as const;

export const zhCN: DictOf<typeof en> = {
  // Permission levels
  'level.plan.detail': '行动前先列计划，提出的操作均等待你确认',
  'level.ask.detail': '修改文件与执行命令均等待你确认',
  'level.edits.detail': '允许修改工作目录内的文件；执行命令等待你确认',
  'level.auto.detail': '提出的所有操作均直接批准',
  'level.full.detail': '无提示模式：不询问任何操作，且无沙箱限制',
  'level.apiAgent.detail': '仅调用云端 API，不在本机执行任何操作',
  'level.ask.agyDetail': '修改文件直接放行；执行命令等待你确认',
  'level.ask.noModeDetail': '提出的任何操作请求均等待你确认',

  // Setting row labels
  'row.agent.label': '默认代理',
  'row.model.label': '默认模型 · {target}',
  'row.permissions.label': '权限档位 · {target}',
  'row.delegation.label': '子代理启动确认',
  'row.idle.label': '空闲回收时间',
  'row.scope.label': '会话共享范围',
  'row.stream.label': '打字机流式输出',
  'row.voice.label': '语音识别结果确认',
  'row.cleanup.label': '语音口语化修饰清洗',
  'row.reviewAgent.label': '自动复盘代理',
  'row.reviewModel.label': '复盘模型',
  'row.locale.label': '语言',

  // Group names and notes
  'group.agents': '代理设置',
  'group.subagents': '子代理',
  'group.conversations': '会话与上下文',
  'group.replies': '回复效果',
  'group.voice': '语音转文字',
  'group.reviews': '自动复盘',
  'group.general': '通用',
  'group.more': '更多',
  'group.note.agents':
    '各个代理的独立设置。默认模型自下次会话（`/new`）生效，`/model` 仅覆盖当前话题；权限档位即时生效。',
  'group.note.reviews':
    '由代理阅读已休止的会话，并将沉淀的知识写入技能库。复盘执行时禁用工具并拒绝所有权限申请。',

  // Screen headers & field labels
  'screen.about':
    '这些设置对所有会话生效。修改立即生效（另有说明者除外）；`/model` 与 `/agent` 仅修改当前话题。',
  'field.model': '模型',
  'field.permissions': '权限档位',

  // Setting descriptions
  'desc.agent': '未匹配到路由规则时默认响应的代理。',
  'desc.model': '`{target}` 启动会话时默认使用的模型。`/model` 仍可覆盖单个会话。',
  'desc.permissions':
    '`{target}` 可以在无需人工确认的情况下执行哪些操作。每个档位决定了宿主运行时模式以及操作是否需要等待你批准：`plan`、`ask` 与 `edits` 会以按钮形式向你请示——无人应答时拒绝，绝不默认批准；`auto` 与 `full` 直接批准。仅提供宿主支持的档位。修改立即生效：运行中的会话切换到新模式，其后续请求按新规则响应。',
  'desc.delegation':
    '在 `task-new` 派发子任务时何时等待你在卡片上点击“启动”：始终等待（`on`，默认）、每个会话中每个代理首次询问（`first`）或从不等待（`off`，立即启动各任务并发送卡片记录）。`first` 仅保存在内存中，重启或切换新会话后会重新确认。`first` 与 `off` 仅对你直接对话的会话生效；子代理自身的话题始终会询问。此项仅人工可修改，代理命令无法变更。',
  'desc.idle': '会话静默多久后回收其子代理进程。收到新消息时自动恢复。',
  'desc.scope': '划分独立会话的维度——话题/线程、频道、人员或整个网关共享。',
  'desc.stream':
    '回复是逐字编辑同一条消息流式输出（`on`），还是各部分生成完毕后整段发送（`off`，默认）。关闭时不消耗编辑次数，长回复不会触碰平台的单条消息编辑上限；无论哪种方式，工具调用的边界均会发送分段。',
  'desc.voice':
    '语音识别文本是否等待你点击 ✅ 发送（`on`，默认），还是直接发送给代理（`off`）。无论哪种方式，聊天中都会展示识别结果。',
  'desc.cleanup':
    '是否对语音识别文本进行口语化修饰与清洗（去除语气词、重复和自我修正），并在原文上方展示，点击 ✅ 发送该整理版本（`on`，默认）；或是仅按原词逐字识别（`off`）。',
  'desc.reviewAgent':
    '由哪个代理复盘静默的会话并将所学经验沉淀至技能库。任何代理均可：复盘在其所在机器上执行，宿主允许的情况下禁用工具并拒绝所有权限申请。`off` 关闭自动复盘；指定代理将替代 `review.api` 端点。修改将在下次轮巡（一分钟内）生效。',
  'desc.reviewModel':
    '复盘执行时使用的模型。未设置时沿用复盘代理自身的默认模型；在此选择可为复盘指定不同于代理的模型。`/review.api` 端点在 config.yaml 中声明自身模型。修改将在下次轮巡生效。',
  'desc.locale': '设置项、系统通知及 Web UI 所使用的界面语言。',

  // Setting hints
  'hint.agent': '未匹配到路由规则的新会话将由此代理响应。',
  'hint.delegation':
    '在代理的子任务运行前等待你点击启动。`first` 在每个会话中每位代理仅询问一次；`off` 立即启动。子代理自身的话题仍会询问。',
  'hint.idle': '停止静默达到此时间的代理。收到新消息时自动恢复。',
  'hint.scope': '划分独立会话的维度：话题、频道、个人或整个网关。',
  'hint.stream': '消息逐字流式打印，而不是每段生成完毕后再整段发送。',
  'hint.voice': '暂缓发送语音识别文本，直到你点击 ✅ 发送。',
  'hint.cleanup': '同时生成口语修饰后的语义清洗版，并发送该版本。',
  'hint.reviewAgent': '由代理复盘休止的会话并沉淀经验至技能库。默认关闭。',
  'hint.reviewModel': '复盘执行所用的模型。未设置时沿用复盘代理自身的模型。',
  'hint.locale': '设置页与 Web UI 的界面语言。',

  // Effects
  'effect.live.text': '立即生效',
  'effect.live.sentence': '修改立即生效。',
  'effect.nextSession.label': '下次会话',
  'effect.nextSession.text': '自 {target} 下次会话生效 —— 现可发送 /new 开启新会话',
  'effect.nextSession.sentence': '自 {target} 下次会话生效 —— 现可发送 `/new` 开启新会话。',
  'effect.restart.label': '重启后',
  'effect.restart.text': '守护进程重启后生效；在此之前现有会话保持当前标识',
  'effect.restart.sentence': '守护进程重启后生效；在此之前现有会话保持当前标识。',

  // Unset and sources
  'unset.model': '宿主默认',
  'unset.modelParen': '(宿主默认)',
  'unset.reviewModel': '代理自身模型',
  'unset.permissionSession': '未设置 · 取自运行中会话模式',
  'unset.permissionPin': '未设置 · 取自固定模式',
  'unset.permissionNone': '未设置',
  'source.gateway': '网关设定',
  'source.pod': 'pod.yaml',

  // Options
  'option.delegation.on': '开启 — 运行子任务前必须等待确认',
  'option.delegation.onDetail': '运行子任务前必须等待确认',
  'option.delegation.first': '首次 — 每个会话中每位代理仅首次确认',
  'option.delegation.firstDetail': '每个会话中每位代理仅首次确认',
  'option.delegation.off': '关闭 — 立即启动子任务并发送卡片备案',
  'option.delegation.offDetail': '立即启动子任务并发送卡片备案',
  'option.stream.off': '关闭 — 生成完毕后整段发送',
  'option.stream.offDetail': '生成完毕后整段发送',
  'option.stream.on': '开启 — 逐字编辑同一条消息输出',
  'option.stream.onDetail': '逐字编辑同一条消息输出',
  'option.voice.on': '开启 — 需点击 ✅ 发送后代理才可见',
  'option.voice.onDetail': '需点击 ✅ 发送后代理才可见',
  'option.voice.off': '关闭 — 识别后立即送出',
  'option.voice.offDetail': '识别后立即送出',
  'option.cleanup.on': '开启 — 生成口语修饰版并发送该版',
  'option.cleanup.onDetail': '生成口语修饰版并发送该版',
  'option.cleanup.off': '关闭 — 仅逐字原词记录',
  'option.cleanup.offDetail': '仅逐字原词记录',
  'option.review.off': '关闭 — 不执行自动复盘',
  'option.review.offDetail': '不执行自动复盘',
  'option.idle.never': '关闭 (从不回收)',
  'option.idle.neverDetail': '从不回收',
  'option.scope.perThread': '每个话题/线程独立会话',
  'option.scope.perChannel': '频道内所有子分支共享同一会话',
  'option.scope.perUser': '每位用户跨位置共享同一会话',
  'option.scope.shared': '整个部署实例所有用户共享单一会话',

  // Menu, acks & notices
  'menu.head': '系统设置 —— 保存至 config.yaml，全局生效。点击即可修改。',
  'menu.overflow': '另有 {count} 项（可手动输入）：{keys}',
  'menu.prev': '◀ 上一页',
  'menu.next': '下一页 ▶',
  'menu.back': '◀ 返回',
  'menu.expired': '该设置菜单已失效（已被新菜单取代或网关已重启）。请重新运行 /setting 获取新菜单。',
  'menu.superseded': '系统设置 —— 已被更新的 /setting 菜单取代。',
  'menu.typeModelPlaceholder': '或直接输入模型名称',
  'menu.pageNav': '第 {page}/{total} 页',
  'ack.saved': '已保存 {label} = `{display}`（{effect}）。',
  'ack.overridden': '当前话题生效了 `/model` 临时覆盖，将继续使用 `{model}`，直到执行 `/model default` 或 `/new`。',
  'ack.unchanged': '{label} 已是 `{value}`。',
  'notice.unknownKey': '不存在名为 `{key}` 的设置项。可用设置项：\n{keys}',
  'notice.typedOnly': '请直接为该项输入设置值：`/setting {key} <value>`。',
  'notice.typedOnlyNoLive': '请直接为该代理输入模型名称：`/setting {key} <model>`（未提供可供选择的实时模型列表）。',
  'notice.refused': '`{key}` 无法在聊天中修改 —— {group}必须在配置文件中修改，因为{reason}。\n{action}',
  'notice.editRestart': '编辑 config.yaml 并重启网关守护进程。',
  'notice.editReload': '编辑 config.yaml，然后发送 /reload。',
  'notice.noAgentNamed': '不存在该名称的代理。已配置的代理：{agents}。',

  // Push notifications
  'push.waitingAnswer': '等待你的答复',
  'push.failed': '执行失败',
  'push.finished': '已完成',
};

export type SettingsMessageKey = keyof typeof en;

export const tSettings = createTranslator<SettingsMessageKey>({ en, 'zh-CN': zhCN });
