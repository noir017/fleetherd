import {
  createTranslator,
  type DictOf,
  type DomainTranslator,
} from './index.js';

const en = {
  // ── tool-renderer ──
  afterStopMark: ' · still running after /stop',

  // ── busy-snapshot ──
  usageSnapshotTitle: '**Usage** — gateway snapshot of {agent}',
  usageSnapshotContext: 'Context: {context}',
  usageSnapshotContextNotReported: 'Context: not reported yet',
  usageSnapshotCost: 'Cost: {cost} this session, as of the last finished turn',
  usageSnapshotCostNotReported: 'Cost: not reported',
  usageSnapshotRunning: 'This turn: running {elapsed}',
  busyNote:
    '⏳ {agent} is busy with a turn, and forwarded /{command} would only have been answered after ' +
    'it — so the gateway answered from what it already holds. Send /{command} again once the turn ' +
    "ends for {agent}'s own full answer.",

  // ── turn-retry (buttons) ──
  retryReconnect: 'Reconnect',
  retryResend: 'Resend',
  retryRetry: 'Retry',
  retryAnotherAgent: 'Retry with another agent',

  // ── topic-stage ──
  undeliveredHeld: 'The agent did not receive this — it will be sent along with the next message.',
  undeliveredNotHeld: 'The agent did not receive this.',
  reasonService: 'the model provider failed',
  reasonLimit: 'a usage limit was hit',
  reasonConnection: 'the connection to the model provider failed',
  reasonAccess: 'the agent is not signed in or not allowed',
  reasonRequest: 'the model provider refused the request',
  reasonProvider: 'the model provider failed',
  reasonHung: 'the agent stopped responding',
  reasonStartup: 'the agent could not start',
  reasonPreLaunch: 'the preLaunch hook failed',
  reasonRestart: 'the gateway restarted mid-turn',
  reasonOther: 'the turn failed',

  // ── inbound-merger (stopInputNote) ──
  stopDroppedSingle: 'Dropped this message — the agent never saw it:',
  stopDroppedMultiple: 'Dropped these {count} messages — the agent never saw them:',
  stopKeptSingle:
    'Kept this message for your next one — the agent has not seen it yet, and it goes in with whatever you send next. `/stop` again drops it:',
  stopKeptMultiple:
    'Kept these {count} messages for your next one — the agent has not seen them yet, and they go in with whatever you send next. `/stop` again drops them:',
  stopQuoteAttachmentSingle: '[1 attachment]',
  stopQuoteAttachmentMultiple: '[{count} attachments]',
  stopQuoteMore: '> … and {count} more',

  // ── turn-runner ──
  followUpMarker: '⏱ background update — picking up where the last reply left off',
  asideFooterBase: 'side question — not kept in this conversation',
  asideFooterToolsSingle: '1 tool call',
  asideFooterToolsMultiple: '{count} tool calls',
  turnFailedPrefix: '❌ This turn failed',
  commandFallbackNotice:
    'ℹ️ Ran `{cmd}`, but there was no output to display.\n(A few built-in commands such as /compact don\'t relay their results to IM; an unknown command does nothing.)',

  // ── agent-acp ──
  noticeStillRunningUnresumable:
    '⚠️ {agent} is still running {secs}s after /stop. It cannot resume a stored session, so ending its process would lose this conversation — `/new` ends it and starts over.',
  noticeStillRunningKilled:
    '⏹ {agent} was still running {secs}s after /stop, so its process was ended. The conversation is kept — the next message resumes it.',

  // ── agent-acp-harness ──
  noticeHarnessErrorRetrying: '⚠️ {agent} hit an error and is retrying: {reason}',

  // ── agent-reconnect & agent-common ──
  noticeReconnected: '✅ Reconnected to {target}.',
  noticeLostConnectionTurn:
    '⚠️ Lost the connection to {agent}; reconnecting for up to {span}. Its reply follows once it is back.',
  noticeCannotReachStart:
    '⚠️ Cannot reach {agent}; trying again for up to {span}. The message goes out once it answers.',
  spanMinutesSingle: '1 minute',
  spanMinutesMultiple: '{count} minutes',
  spanSeconds: '{count}s',
  noticeRemoteLost:
    '⚠️ Lost the connection to {host}. The agent keeps working there; its reply follows once the connection is back.',

  // ── agy-acp ──
  noticeAgyRetrying: '⚠️ {agent} hit an error and is retrying: {warning}',
  noticeAgyRecovered: '⚠️ {agent} hit an error and recovered: {warning}',

  // ── conversation-turns & turn-outcomes ──
  gatewayRestartsDoneWaiting: '⏳ The gateway restarts when this turn is done — it is waiting for it to finish.',
  reconnectingTo: '↻ Reconnecting to {bound}…',
  retryingWith: '↻ Retrying with {name}.',
  retryingWithAnswersTopic: '↻ Retrying with {name} — it answers this topic now.',
  retryingInNewTopic: '↻ Retrying with {target} in a new topic — this one stays with {bound}.',
  noSavedInputResend: 'No saved input to resend — send the message again.',
  retryNothingToRetry: 'Nothing to retry any more — a later turn has run since, or this one was already retried.',
  retryConversationGone: 'That conversation is gone — send the message again.',
  retryTurnRunning: 'A turn is running here — Retry once it has ended.',
  retryGatewayRestarting: 'The gateway is restarting — Retry in a minute.',
  retryAgentNotConfigured: 'No agent "{target}" is configured.',
  retryNewTopicMappingFailed: 'The new topic does not map to a conversation of its own here — send the message there yourself.',
  gatewayRestartedInterrupted: '⚠️ The gateway restarted before this turn finished — the agent stopped where it was.',
  notContinuingAgain: '↻ Not continuing again: {max} automatic {continuesWord} in a row ended in a failure too.',
  continuesWordSingle: 'continue',
  continuesWordMultiple: 'continues',
  sendingContinueIn: '↻ {reason} — sending “{preview}” in {seconds} ({attempt}/{max}). Send anything, or /stop, to call it off.',
  limitNoticeWaitingFirst: 'in {seconds}',
  limitNoticeWaitingLater: 'once another conversation on it gets through',
  limitNoticeOthersSingle: '; 1 more conversation waits for this one to get through',
  limitNoticeOthersMultiple: '; {count} more conversations wait for this one to get through',
  limitNotice: '↻ {reason} on {agent} — sending “{preview}” {when} ({attempt}/{max}){behind}. Send anything, or /stop, to call it off.',
  notContinuingLimit: '↻ Not continuing: {agent} stayed over its usage limit through {max} automatic {continuesWord}.',

  // ── stop acks ──
  stopAckRunning: '⏹ Stopped. The reply above is as far as it got — the conversation is kept, so just send the next message.',
  stopAckCollecting: '⏹ Stopped before the turn started. Nothing reached the agent.',
  stopAckBackground:
    '⏹ Stopped the background work. The update above is as far as it got — the conversation is kept, so just send the next message.',
  stopAckIdle: 'Nothing is running here.',
  stopAckQuestion: '⏹ Called off the question above. Nothing else was running.',
  stopAckVoice: '⏹ Called off the voice transcript — nothing was sent. Nothing else was running.',
};

const zhCN: DictOf<typeof en> = {
  // ── tool-renderer ──
  afterStopMark: ' · /stop 后仍在运行',

  // ── busy-snapshot ──
  usageSnapshotTitle: '**资源占用** — {agent} 的网关快照',
  usageSnapshotContext: '上下文：{context}',
  usageSnapshotContextNotReported: '上下文：尚未报告',
  usageSnapshotCost: '费用：本会话截至上一轮已产生 {cost}',
  usageSnapshotCostNotReported: '费用：未报告',
  usageSnapshotRunning: '本轮：已运行 {elapsed}',
  busyNote:
    '⏳ {agent} 正在忙于处理本轮，转发的 /{command} 只能排在其后执行——因此网关根据当前已知状态作出了答复。本轮结束后再次发送 /{command} 可获取 {agent} 自身的完整答复。',

  // ── turn-retry (buttons) ──
  retryReconnect: '重连',
  retryResend: '重发',
  retryRetry: '重试',
  retryAnotherAgent: '换个 agent 重试',

  // ── topic-stage ──
  undeliveredHeld: 'Agent 未收到此消息 — 将在下一条消息发送时一同带上。',
  undeliveredNotHeld: 'Agent 未收到此消息。',
  reasonService: '模型服务商发生故障',
  reasonLimit: '触发用量或速率限制',
  reasonConnection: '连接模型服务商失败',
  reasonAccess: 'Agent 未登录或无权限',
  reasonRequest: '模型服务商拒绝了请求',
  reasonProvider: '模型服务商发生故障',
  reasonHung: 'Agent 停止响应',
  reasonStartup: 'Agent 启动失败',
  reasonPreLaunch: 'preLaunch 钩子执行失败',
  reasonRestart: '网关在中途重启',
  reasonOther: '本轮运行失败',

  // ── inbound-merger (stopInputNote) ──
  stopDroppedSingle: '已丢弃此消息 — Agent 未曾处理过它：',
  stopDroppedMultiple: '已丢弃这 {count} 条消息 — Agent 未曾处理过它们：',
  stopKeptSingle:
    '已保留此消息并在下一条发出 — Agent 尚未处理它，将随您发送的下一条消息一同进入。再次 /stop 将丢弃它：',
  stopKeptMultiple:
    '已保留这 {count} 条消息并在下一条发出 — Agent 尚未处理它们，将随您发送的下一条消息一同进入。再次 /stop 将丢弃它们：',
  stopQuoteAttachmentSingle: '[1 个附件]',
  stopQuoteAttachmentMultiple: '[{count} 个附件]',
  stopQuoteMore: '> … 以及另外 {count} 条',

  // ── turn-runner ──
  followUpMarker: '⏱ 后台更新 — 接着上一条回复继续',
  asideFooterBase: '旁白提问 — 不计入当前对话历史',
  asideFooterToolsSingle: '1 次工具调用',
  asideFooterToolsMultiple: '{count} 次工具调用',
  turnFailedPrefix: '❌ 本轮运行失败',
  commandFallbackNotice:
    'ℹ️ 已运行 `{cmd}`，但没有可显示的输出。\n（少数内置命令如 /compact 的结果不会转发展示到聊天平台；未知命令不会执行任何操作。）',

  // ── agent-acp ──
  noticeStillRunningUnresumable:
    '⚠️ {agent} 在 /stop 后仍在运行（已达 {secs} 秒）。由于它无法恢复已保存的会话，终止其进程将丢失此对话 — 请使用 `/new` 结束进程并重新开始。',
  noticeStillRunningKilled:
    '⏹ {agent} 在 /stop 后仍运行了 {secs} 秒，进程已被强制终止。对话记录已保留 — 发送下一条消息即可恢复。',

  // ── agent-acp-harness ──
  noticeHarnessErrorRetrying: '⚠️ {agent} 遇到错误正在重试：{reason}',

  // ── agent-reconnect & agent-common ──
  noticeReconnected: '✅ 已重新连接到 {target}。',
  noticeLostConnectionTurn:
    '⚠️ 与 {agent} 的连接已断开；正在尝试重连（最多等待 {span}）。恢复后将继续发送回复。',
  noticeCannotReachStart:
    '⚠️ 无法连接到 {agent}；正在尝试重试（最多等待 {span}）。待其响应后将发送消息。',
  spanMinutesSingle: '1 分钟',
  spanMinutesMultiple: '{count} 分钟',
  spanSeconds: '{count} 秒',
  noticeRemoteLost:
    '⚠️ 与 {host} 的连接已断开。Agent 仍在远端继续工作；连接恢复后将返回其答复。',

  // ── agy-acp ──
  noticeAgyRetrying: '⚠️ {agent} 遇到错误正在重试：{warning}',
  noticeAgyRecovered: '⚠️ {agent} 遇到错误并已恢复：{warning}',

  // ── conversation-turns & turn-outcomes ──
  gatewayRestartsDoneWaiting: '⏳ 网关将在本轮结束后重启 — 正在等待其完成。',
  reconnectingTo: '↻ 正在重连到 {bound}…',
  retryingWith: '↻ 正在使用 {name} 重试。',
  retryingWithAnswersTopic: '↻ 正在使用 {name} 重试 — 此话题现由它负责答复。',
  retryingInNewTopic: '↻ 正在新话题中使用 {target} 重试 — 当前话题仍保留给 {bound}。',
  noSavedInputResend: '没有已保存的输入可供重发 — 请重新发送该消息。',
  retryNothingToRetry: '无可重试的内容 — 后续轮次已运行，或此前已完成重试。',
  retryConversationGone: '该对话已不存在 — 请重新发送该消息。',
  retryTurnRunning: '本对话已有轮次正在运行 — 请等待结束后重试。',
  retryGatewayRestarting: '网关正在重启 — 请稍候重试。',
  retryAgentNotConfigured: '未配置名为 "{target}" 的 Agent。',
  retryNewTopicMappingFailed: '新话题无法映射到对应的独立对话 — 请直接在该话题中发送消息。',
  gatewayRestartedInterrupted: '⚠️ 网关在本轮结束前已重启 — Agent 已在原处停止。',
  notContinuingAgain: '↻ 不再自动续跑：连续 {max} {continuesWord}均以失败告终。',
  continuesWordSingle: '次续跑',
  continuesWordMultiple: '次续跑',
  sendingContinueIn: '↻ {reason} — 将在 {seconds} 后发送“{preview}”（第 {attempt}/{max} 次）。发送任意消息或 /stop 可取消。',
  limitNoticeWaitingFirst: '将在 {seconds} 后',
  limitNoticeWaitingLater: '待该 Agent 上的其他对话通过后',
  limitNoticeOthersSingle: '；另有 1 个对话正在等待本次成功',
  limitNoticeOthersMultiple: '；另有 {count} 个对话正在等待本次成功',
  limitNotice: '↻ {agent} {reason} — {when}发送“{preview}”（第 {attempt}/{max} 次）{behind}。发送任意消息或 /stop 可取消。',
  notContinuingLimit: '↻ 不再续跑：{agent} 在连续 {max} {continuesWord}中均处于超用量状态。',

  // ── stop acks ──
  stopAckRunning: '⏹ 已停止。上方的回复是目前的全部输出 — 对话记录已保留，直接发送下一条消息即可。',
  stopAckCollecting: '⏹ 在本轮开始前已停止。没有内容进入 Agent。',
  stopAckBackground:
    '⏹ 已停止后台工作。上方的更新是目前的全部输出 — 对话记录已保留，直接发送下一条消息即可。',
  stopAckIdle: '当前没有运行中的任务。',
  stopAckQuestion: '⏹ 已取消上方的提问。没有其他正在运行的任务。',
  stopAckVoice: '⏹ 已取消语音转写 — 未发送任何内容。没有其他正在运行的任务。',
};

export type RuntimeMessageKey = keyof typeof en;

export const RUNTIME_DICTS = {
  en,
  'zh-CN': zhCN,
} as const;

export const tRuntime: DomainTranslator<RuntimeMessageKey> = createTranslator({
  en,
  'zh-CN': zhCN,
});
