import { createTranslator, type DictOf, type DomainTranslator } from './index.js';

const en = {
  // Schedule - When & Run
  'schedule.when.once': 'once at {time} ({tz})',
  'schedule.run.fixed': 'fixed session',
  'schedule.run.daily': 'one session a day',
  'schedule.run.new': 'new session each run',
  'schedule.run.bashWake': 'bash · wake ({rule}, max {max})',
  'schedule.nextSuffix': ' · next {time}',

  // Schedule - Last Run & States & Statuses
  'schedule.lastRun.none': 'not run yet',
  'schedule.status.ok': '✅',
  'schedule.status.failed': '❌',
  'schedule.status.interrupted': '⏹ interrupted',
  'schedule.status.skipped': '⏭ skipped',
  'schedule.status.missed': '⌛ missed',
  'schedule.status.failedVerb': 'failed',
  'schedule.status.skippedVerb': 'skipped',
  'schedule.status.missedVerb': 'missed',
  'schedule.state.active': 'active',
  'schedule.state.paused': '⏸ paused',
  'schedule.state.expired': '⌛ expired',
  'schedule.state.done': '✔ done',

  // Schedule - Verbs
  'schedule.verb.registered': 'registered',
  'schedule.verb.updated': 'updated',
  'schedule.verb.removed': 'removed',
  'schedule.verb.paused': 'paused',
  'schedule.verb.resumed': 'resumed',

  // Schedule - Card & List
  'schedule.card.header': '⏰ Scheduled task {verb} — `#{id}` **{name}**',
  'schedule.card.when': '• When: {value}',
  'schedule.card.runs': '• Runs: {value}',
  'schedule.card.until': ' · until {time}',
  'schedule.card.postsTo': '• Posts to: `{target}`',
  'schedule.card.command': '• Command: {command}',
  'schedule.card.prompt': '• Prompt:',
  'schedule.card.tags': '• Tags: {tags}',
  'schedule.card.state': '• State: {state}',
  'schedule.card.footer': '`/setting schedule` lists, pauses and deletes tasks.',
  'schedule.list.empty':
    'No scheduled tasks. An agent registers one with `fleetherd schedule add` — ask for "every morning at 8, …" in any conversation.',
  'schedule.list.title': '**Scheduled tasks**',
  'schedule.line.last': ' · last {lastRun}',
  'schedule.runNotice': '⏰ Scheduled task `#{id}` **{name}** · {planned}\n> {body}',
  'schedule.expired':
    '⌛ Scheduled task `#{id}` **{name}** has expired — a fixed-session task lives {hours}h. It ran {runs} time(s). Ask for it again with a new session if it should keep going.',
  'schedule.wakeCap':
    '⏹ Scheduled task `#{id}` **{name}** reached its wake limit ({wakes}/{max}) and ended.',

  // Schedule - Bash Result
  'schedule.bash.stopped': 'the gateway stopped while it ran',
  'schedule.bash.timedOut': 'timed out after {duration}',
  'schedule.bash.noOutput': '(no output)',
  'schedule.bash.attachedNote': '\n…last {shown} characters of {bytes} bytes; the full output is attached.',

  // Schedule Menu
  'schedule.menu.entryLabel': '⏰ Scheduled tasks · {active} active{other}',
  'schedule.menu.entryOther': ', {count} other',
  'schedule.menu.settingsButton': '◀ Settings',
  'schedule.menu.listHint': '\n\nTap one to pause, resume or delete it.',
  'schedule.menu.listOverflow':
    '\n{count} more not shown as buttons — `/setting schedule pause|resume|delete <id>` works for any.',
  'schedule.menu.taskWhen': '• When: {value}',
  'schedule.menu.taskRuns': '• Runs: {value}',
  'schedule.menu.taskPostsTo': '• Posts to: `{target}`',
  'schedule.menu.taskLastRun': '• Last run: {last} · {runs} run(s) so far',
  'schedule.menu.commandLabel': 'Command',
  'schedule.menu.promptLabel': 'Prompt',
  'schedule.menu.btnPause': '⏸ Pause',
  'schedule.menu.btnResume': '▶ Resume',
  'schedule.menu.btnDelete': '🗑 Delete',
  'schedule.menu.btnBack': '◀ Back',
  'schedule.menu.deleteConfirm': 'Delete `#{id}` **{name}**? It stops running and cannot be brought back.',
  'schedule.menu.btnConfirmDelete': '🗑 Yes, delete it',
  'schedule.menu.btnCancel': 'Cancel',
  'schedule.menu.expired':
    'This menu has expired (the gateway restarted, or a newer one was opened). Send `/setting schedule` again.',

  // Schedule Service
  'schedule.service.failedNotice': '⏰ `#{id}` **{name}** failed — {why}.',
  'schedule.service.missedNotice': '⏰ `#{id}` **{name}** {verb} at {time} — {why}.',

  // Voice
  'voice.card.header': '🎙️ Voice transcript · {model} · {seconds}s',
  'voice.card.cleanedHeader': '✍️ Cleaned up:',
  'voice.card.spokenHeader': '🗣️ As spoken:',
  'voice.card.spokenTooLong': '🗣️ As spoken: too long to show beside the cleaned-up version (it is in the voice log).',
  'voice.card.notCleaned': '\n\n✍️ Not cleaned up: {error}.',
  'voice.card.previewMore': '({count} more characters not shown here — the full text is what gets sent)',
  'voice.status.pendingCleaned':
    'Send the cleaned-up version to the agent? Tap ✅ Send, or 🗣️ Send as spoken for the words as heard — or type your own, and this one is dropped.',
  'voice.status.pendingRaw':
    'Send this to the agent? Tap ✅ Send — or type a corrected version instead, and this one is dropped.',
  'voice.status.sentCleaned': '→ Sent the cleaned-up version to the agent.',
  'voice.status.sentRaw': '→ Sent to the agent.',
  'voice.status.sentAsSpoken': '→ Sent to the agent as spoken.',
  'voice.status.autoCleaned': '→ Sent the cleaned-up version to the agent automatically.',
  'voice.status.autoRaw': '→ Sent to the agent automatically.',
  'voice.status.autoNoButtonsCleaned':
    '→ Sent the cleaned-up version to the agent automatically (this platform cannot show confirm buttons).',
  'voice.status.autoNoButtonsRaw':
    '→ Sent to the agent automatically (this platform cannot show confirm buttons).',
  'voice.status.cancelled': '✖ Cancelled — nothing was sent.',
  'voice.status.expired':
    '⌛ Expired after {minutes} min — nothing was sent. Send the voice message again if you still want it.',
  'voice.status.superseded': '✎ Replaced by the message you typed — this transcript was not sent.',
  'voice.status.calledOff': '⏹ Called off ({reason}) — nothing was sent.',
  'voice.failure':
    "🎙️ Couldn't transcribe that voice message: {reason}. Nothing was sent to the agent — type it instead, or send it again.",
  'voice.noSpeech': '🎙️ No speech was recognized in that voice message. Nothing was sent to the agent.',
  'voice.staleClick':
    'That transcript is no longer waiting (already handled, expired, or the gateway restarted). Send the voice message again if it still needs sending.',
  'voice.button.send': '✅ Send',
  'voice.button.sendAsSpoken': '🗣️ Send as spoken',
  'voice.button.cancel': '✖ Cancel',

  // Delegation (/super)
  'delegation.confirm.startOne': 'Start it',
  'delegation.confirm.startAll': 'Start all {count}',
  'delegation.confirm.cancel': 'Cancel',
  'delegation.notStarted': 'Not started — {why}.',
  'delegation.confirm.ask': '**{asker} wants to start {targets}** — each in a topic of its own under this one:',
  'delegation.confirm.targetOne': 'a sub-agent',
  'delegation.confirm.targetMany': '{count} sub-agents',
  'delegation.confirm.review':
    '   Reviewed by **{agent}** in the same directory, on its own, whenever a turn ends with new commits — sent back at most {rounds} time{s}:',
  'delegation.confirm.extFooter':
    '{caller} is outside this gateway and does not read this topic. Cancel refuses; it may propose again.',
  'delegation.confirm.footer': 'To change them, say what to change instead of tapping.',
  'delegation.started.head': '**{names}** — {target}{by}, {topicDesc} under this one:',
  'delegation.started.by': ' started by {asker}',
  'delegation.started.topicOne': 'in a topic of its own',
  'delegation.started.topicMany': 'each in a topic of its own',
  'delegation.started.model': 'model `{model}`',
  'delegation.started.reviewedBy': 'reviewed by {reviewer}',
  'delegation.started.couldNotStart': 'Could not start {count}:',
  'delegation.started.failedDirect':
    '**{asker} could not start the sub-agent** — no confirmation is asked here, so it was tried at once:',
  'delegation.started.confirmFooterFirst':
    'Here confirmation is asked once per agent in each conversation; `/setting delegation on` asks every time.',
  'delegation.started.confirmFooterOther': '`/setting delegation on` makes new sub-tasks wait for Start again.',
  'delegation.stop.by': '⏹ Stopped by {by} in [{title}](?t={thread}).',
  'delegation.stop.withSlash': '⏹ Stopped with /stop in [{title}](?t={thread}).',
  'delegation.stop.held':
    ' {count} message(s) sent there while it ran never reached it; they are kept and go in with the next message there.',
  'delegation.stop.nothingRunning': 'Nothing was running there.',
  'delegation.stop.stoppedKept': 'Stopped. Its context is kept; a message there carries on from it.',
  'delegation.limit.exceeded':
    '⏸ {agentId} is over its usage limit — {updates} from {count} sub-agent{s} will reach it once the limit lifts.',
  'delegation.limit.updateSingular': 'an update',
  'delegation.limit.updatePlural': 'updates',
  'delegation.stage.answer': 'waiting on a question',
  'delegation.stage.failed': 'failed',
  'delegation.stage.review': 'turn ended',
  'delegation.stage.retrying': 'failed, continuing automatically',
  'delegation.stage.working': 'working',
  'delegation.stage.idle': 'idle',
  'delegation.report.afterWrote': ' after you wrote there',
  'delegation.report.extra': '🔔 {count} more — see fleetherd tasks',
} as const;

export type WorkflowMessageKey = keyof typeof en;

const zhCN: DictOf<typeof en> = {
  // Schedule - When & Run
  'schedule.when.once': '一次性于 {time} ({tz})',
  'schedule.run.fixed': '固定会话',
  'schedule.run.daily': '每天一个会话',
  'schedule.run.new': '每次新建会话',
  'schedule.run.bashWake': 'bash · 唤醒（{rule}，最多 {max} 次）',
  'schedule.nextSuffix': ' · 下次执行 {time}',

  // Schedule - Last Run & States & Statuses
  'schedule.lastRun.none': '尚未运行',
  'schedule.status.ok': '✅',
  'schedule.status.failed': '❌',
  'schedule.status.interrupted': '⏹ 已中断',
  'schedule.status.skipped': '⏭ 已跳过',
  'schedule.status.missed': '⌛ 已错过',
  'schedule.status.failedVerb': '执行失败',
  'schedule.status.skippedVerb': '已跳过',
  'schedule.status.missedVerb': '已错过',
  'schedule.state.active': '运行中',
  'schedule.state.paused': '⏸ 已暂停',
  'schedule.state.expired': '⌛ 已过期',
  'schedule.state.done': '✔ 已完成',

  // Schedule - Verbs
  'schedule.verb.registered': '已注册',
  'schedule.verb.updated': '已更新',
  'schedule.verb.removed': '已删除',
  'schedule.verb.paused': '已暂停',
  'schedule.verb.resumed': '已恢复',

  // Schedule - Card & List
  'schedule.card.header': '⏰ 定时任务{verb} — `#{id}` **{name}**',
  'schedule.card.when': '• 执行时间：{value}',
  'schedule.card.runs': '• 运行模式：{value}',
  'schedule.card.until': ' · 截止至 {time}',
  'schedule.card.postsTo': '• 发送至：`{target}`',
  'schedule.card.command': '• 命令：{command}',
  'schedule.card.prompt': '• 提示词：',
  'schedule.card.tags': '• 标签：{tags}',
  'schedule.card.state': '• 状态：{state}',
  'schedule.card.footer': '可通过 `/setting schedule` 查看、暂停或删除任务。',
  'schedule.list.empty':
    '暂无定时任务。Agent 可通过 `fleetherd schedule add` 注册 — 可在任意会话中输入类似“每天早上 8 点…”发起添加。',
  'schedule.list.title': '**定时任务**',
  'schedule.line.last': ' · 上次运行 {lastRun}',
  'schedule.runNotice': '⏰ 定时任务 `#{id}` **{name}** · {planned}\n> {body}',
  'schedule.expired':
    '⌛ 定时任务 `#{id}` **{name}** 已过期 — 固定会话任务有效期为 {hours} 小时。共运行了 {runs} 次。如需继续运行，请以新会话模式重新创建。',
  'schedule.wakeCap':
    '⏹ 定时任务 `#{id}` **{name}** 已达到唤醒上限（{wakes}/{max}）并结束。',

  // Schedule - Bash Result
  'schedule.bash.stopped': '网关在运行期间已停止',
  'schedule.bash.timedOut': '运行超时（超过 {duration}）',
  'schedule.bash.noOutput': '(无输出)',
  'schedule.bash.attachedNote': '\n…仅展示 {bytes} 字节中的最后 {shown} 个字符；完整输出见附件。',

  // Schedule Menu
  'schedule.menu.entryLabel': '⏰ 定时任务 · {active} 个活跃{other}',
  'schedule.menu.entryOther': '，{count} 个其他',
  'schedule.menu.settingsButton': '◀ 设置',
  'schedule.menu.listHint': '\n\n点击任务可暂停、恢复或删除。',
  'schedule.menu.listOverflow':
    '\n另有 {count} 个未作为按钮展示 — 可使用 `/setting schedule pause|resume|delete <id>` 管理。',
  'schedule.menu.taskWhen': '• 执行时间：{value}',
  'schedule.menu.taskRuns': '• 运行模式：{value}',
  'schedule.menu.taskPostsTo': '• 发送至：`{target}`',
  'schedule.menu.taskLastRun': '• 上次运行：{last} · 至今已运行 {runs} 次',
  'schedule.menu.commandLabel': '命令',
  'schedule.menu.promptLabel': '提示词',
  'schedule.menu.btnPause': '⏸ 暂停',
  'schedule.menu.btnResume': '▶ 恢复',
  'schedule.menu.btnDelete': '🗑 删除',
  'schedule.menu.btnBack': '◀ 返回',
  'schedule.menu.deleteConfirm': '确定删除 `#{id}` **{name}**？任务将停止运行且无法恢复。',
  'schedule.menu.btnConfirmDelete': '🗑 是的，删除它',
  'schedule.menu.btnCancel': '取消',
  'schedule.menu.expired': '此菜单已过期（网关已重启，或打开了更新的菜单）。请重新发送 `/setting schedule`。',

  // Schedule Service
  'schedule.service.failedNotice': '⏰ `#{id}` **{name}** 执行失败 — {why}。',
  'schedule.service.missedNotice': '⏰ `#{id}` **{name}** 于 {time} {verb} — {why}。',

  // Voice
  'voice.card.header': '🎙️ 语音转写 · {model} · {seconds}s',
  'voice.card.cleanedHeader': '✍️ 整理后：',
  'voice.card.spokenHeader': '🗣️ 语音原样：',
  'voice.card.spokenTooLong': '🗣️ 语音原样：内容过长无法与整理版并排展示（已记录在语音日志中）。',
  'voice.card.notCleaned': '\n\n✍️ 未能润色整理：{error}。',
  'voice.card.previewMore': '(此处省略 {count} 个字符 — 完整文本将被发送)',
  'voice.status.pendingCleaned':
    '是否将整理后的内容发送给 Agent？点击 ✅ 发送，或点击 🗣️ 按原样发送发送听到的原文 — 亦可直接输入，此卡片将自动作废。',
  'voice.status.pendingRaw': '是否将此内容发送给 Agent？点击 ✅ 发送 — 亦可直接输入修改后的内容，此卡片将自动作废。',
  'voice.status.sentCleaned': '→ 已将整理后的版本发送给 Agent。',
  'voice.status.sentRaw': '→ 已发送给 Agent。',
  'voice.status.sentAsSpoken': '→ 已按语音原样发送给 Agent。',
  'voice.status.autoCleaned': '→ 已自动将整理后的版本发送给 Agent。',
  'voice.status.autoRaw': '→ 已自动发送给 Agent。',
  'voice.status.autoNoButtonsCleaned':
    '→ 已自动将整理后的版本发送给 Agent（当前平台不支持展示确认按钮）。',
  'voice.status.autoNoButtonsRaw': '→ 已自动发送给 Agent（当前平台不支持展示确认按钮）。',
  'voice.status.cancelled': '✖ 已取消 — 未发送任何内容。',
  'voice.status.expired':
    '⌛ 已超过 {minutes} 分钟过期 — 未发送任何内容。如仍需发送，请重新发送语音消息。',
  'voice.status.superseded': '✎ 已被你输入的文本消息替代 — 此语音转写未发送。',
  'voice.status.calledOff': '⏹ 已终止（{reason}）— 未发送任何内容。',
  'voice.failure':
    '🎙️ 无法转写该语音消息：{reason}。未向 Agent 发送任何内容 — 请直接输入文本或重新发送。',
  'voice.noSpeech': '🎙️ 该语音消息中未识别出任何语音。未向 Agent 发送任何内容。',
  'voice.staleClick':
    '该转写已不再处于等待状态（可能已处理、已过期或网关已重启）。如仍需发送，请重新发送语音消息。',
  'voice.button.send': '✅ 发送',
  'voice.button.sendAsSpoken': '🗣️ 按原样发送',
  'voice.button.cancel': '✖ 取消',

  // Delegation (/super)
  'delegation.confirm.startOne': '启动',
  'delegation.confirm.startAll': '全部启动 {count}',
  'delegation.confirm.cancel': '取消',
  'delegation.notStarted': '未能启动 — {why}。',
  'delegation.confirm.ask': '**{asker} 申请启动 {targets}** — 各在当前话题下的独立话题中运行：',
  'delegation.confirm.targetOne': '1 个子 Agent',
  'delegation.confirm.targetMany': '{count} 个子 Agent',
  'delegation.confirm.review':
    '   由 **{agent}** 在同目录下独立审查，每当轮次以新提交结束时触发 — 最多发回 {rounds} 次：',
  'delegation.confirm.extFooter':
    '{caller} 在本网关外部且不读取本话题。点击“取消”将拒绝；其可能再次发起提议。',
  'delegation.confirm.footer': '如需修改，请直接输入修改意见，无需点击按钮。',
  'delegation.started.head': '**{names}** — {target}{by}，{topicDesc}：',
  'delegation.started.by': '（由 {asker} 启动）',
  'delegation.started.topicOne': '在当前话题下的独立话题中',
  'delegation.started.topicMany': '各在当前话题下的独立话题中',
  'delegation.started.model': '模型 `{model}`',
  'delegation.started.reviewedBy': '由 {reviewer} 审查',
  'delegation.started.couldNotStart': '未能启动 {count} 个：',
  'delegation.started.failedDirect':
    '**{asker} 未能启动子 Agent** — 当前无需确认，已直接尝试启动：',
  'delegation.started.confirmFooterFirst':
    '当前设置下每个会话中每个 Agent 仅首次询问确认；`/setting delegation on` 可设为每次均询问。',
  'delegation.started.confirmFooterOther': '`/setting delegation on` 可让新的子任务再次等待点击“启动”。',
  'delegation.stop.by': '⏹ 已由 {by} 在 [{title}](?t={thread}) 中停止。',
  'delegation.stop.withSlash': '⏹ 已通过 /stop 在 [{title}](?t={thread}) 中停止。',
  'delegation.stop.held':
    ' 运行期间向其发送的 {count} 条消息未送达；这些消息已保留，将在下次发送消息时一并进入。',
  'delegation.stop.nothingRunning': '该话题下当前没有正在运行的任务。',
  'delegation.stop.stoppedKept': '已停止。上下文已保留；向其发送消息可继续。',
  'delegation.limit.exceeded':
    '⏸ {agentId} 已超出使用限额 — 来自 {count} 个子 Agent 的{updates}将在限额解除后送达。',
  'delegation.limit.updateSingular': '更新',
  'delegation.limit.updatePlural': '更新',
  'delegation.stage.answer': '等待回答问题',
  'delegation.stage.failed': '运行失败',
  'delegation.stage.review': '轮次结束',
  'delegation.stage.retrying': '运行失败，自动继续',
  'delegation.stage.working': '正在运行',
  'delegation.stage.idle': '空闲',
  'delegation.report.afterWrote': '在你发言后',
  'delegation.report.extra': '🔔 还有 {count} 个 — 详见 fleetherd tasks',
};

export const tWorkflows: DomainTranslator<WorkflowMessageKey> = createTranslator({
  en,
  'zh-CN': zhCN,
});
