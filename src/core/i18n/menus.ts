import {
  createTranslator,
  type DictOf,
  type DomainTranslator,
  type Locale,
} from './index.js';

export type { Locale };

export const en = {
  // Command descriptions
  cmd_desc_new: 'Start a fresh conversation (clears context)',
  cmd_desc_clear: 'Alias of /new: start a fresh conversation',
  cmd_desc_stop: 'Stop the current turn or background work (keeps the conversation)',
  cmd_desc_kill: 'End the agent process (keeps the conversation; the next message resumes it)',
  cmd_desc_cd: 'Choose the working directory (starts a fresh session there)',
  cmd_desc_agent: 'Choose which agent answers this topic (grouped by machine)',
  cmd_desc_setting: 'Change a saved setting (default agent, model, session)',
  cmd_desc_reload: 'Apply an edited config.yaml without restarting the daemon',
  cmd_desc_title: 'Name this topic (it is named automatically otherwise)',
  cmd_desc_fork: 'Copy this conversation into a new topic beside it (web UI)',
  cmd_desc_skills: "List the current agent's own commands",
  cmd_desc_help: 'List the commands this gateway understands',

  cmd_desc_compact: 'Compact the conversation to free up context',
  cmd_desc_context: 'Show current context usage',
  cmd_desc_model: 'Show or change the model',
  cmd_desc_effort: 'Show or change the reasoning effort',
  cmd_desc_usage: 'Show token usage and limits',
  cmd_desc_doctor: "Health-check this agent's own setup",
  cmd_desc_mcp: 'Manage MCP servers',
  cmd_desc_init: "Set up this project's agent instructions file",
  cmd_desc_review: 'Review the current changes',
  cmd_desc_super: 'Split a job across agents working in parallel (sub-agents)',
  cmd_arg_super_job: 'The job to split up',
  cmd_desc_btw: 'Ask a side question: answered apart, kept out of the conversation, no turn stopped',
  cmd_arg_btw_question: 'What to ask',

  cmd_use_agent: 'Use {target}',
  cmd_use_agent_picker: 'Use {target} — alone, lists its own commands',

  help_gateway_header: '**This gateway**',
  help_agents_header: '**Agents** — `/<cmd> <prompt>` asks it; alone, lists its commands. A topic keeps the agent it started with; `/new` to choose again',
  help_generic_header: '**Works on the current agent**',
  help_answering_now: 'Answering now: **{target}**',

  unconfigured_harness:
    'No {missing} agent is configured here, so /{missing} selects nothing. Add one under `agents:` in config.yaml (`harness: {missing}`) and send /reload; /help lists the agents this gateway does have.',

  // Agent menu
  agent_menu_which_machine: 'Which machine?{current}',
  agent_menu_now: ' (now: {current})',
  agent_menu_back_machines: '‹ machines',
  agent_menu_offline_note: 'offline',
  agent_menu_offline_warning: '\n{name} is offline: its agents cannot answer until it is back.',
  agent_menu_retry_question: 'Retry with which agent{where}?',
  agent_menu_answer_question: 'Which agent{where} should answer this topic?',
  agent_menu_where: ' on {name}',
  agent_list_header: 'Agents (`/agent <id>` chooses one for this topic):',
  agent_list_offline_banner: '({name} is offline)',
  agent_match_none: 'No agent matches "{query}".\n{list}',
  agent_match_many: '"{query}" matches {ids} — which one?',
  agent_bound_ack: '▸ this conversation is now answered by {name} — just type to continue',

  // Model menu
  model_menu_prev: '◀ Prev',
  model_menu_next: 'Next ▶',
  model_menu_text:
    'Model: {current}\n{count} available{pageNote} — tap one, or `/model <part of a name>`.',
  model_menu_page_note: ' · page {page}/{total}',
  model_menu_unknown: 'unknown',
  model_summary_text:
    'Model: {current}\n{count} available — `/model <part of a name>` to switch (e.g. `/model sonnet`).',
  model_no_selector:
    'This agent offers no model selector — it does not let the model be chosen at runtime. Set `agents[].model` (or the harness\'s own env, e.g. ANTHROPIC_MODEL) in config.yaml and send /reload to change it.',
  model_start_failed: 'Could not start this agent, so its model list is unavailable:\n{reason}',
  model_no_match:
    'No model matches "{query}". `/model` alone shows the current one and how many are offered.',
  model_ambiguous: '"{query}" matches {count} models:\n{list}{more}',
  model_ambiguous_more: '\n…and {count} more',
  model_applied: 'Model set to `{model}` for this conversation.',
  model_unavailable:
    'No live session to switch — it starts with the next message. Send one, then /model.',
  model_missing:
    '`{value}` is no longer offered by this agent. Run /model again for the current list.',
  model_rebound:
    'This conversation is answered by {agent} now, so that menu no longer applies. Run /model again.',
  model_gone: 'That conversation is gone — send a message first, then /model.',
  model_failed: 'Could not switch model: {reason}',
  model_expired:
    'That model menu has expired (superseded, or the gateway restarted). Run /model again for a fresh one.',
  model_superseded: 'Model: {current} — superseded by a newer /model menu.',

  // Effort menu
  effort_menu_text: 'Effort: {current}\nTap one, or `/effort <level>`.',
  effort_summary_text: 'Effort: {current}\nOffered: {list} — `/effort <level>` to switch.',
  effort_on_current_model: 'the current model',
  effort_no_selector_codex:
    'Codex offers no effort levels for {on}. codex takes them from its own model catalog, and the installed codex-cli has none for this model (a newer codex-cli may). `/model` can switch to a model it knows; until then the level comes from `model_reasoning_effort` in ~/.codex/config.toml.',
  effort_no_selector_opencode:
    'OpenCode offers no effort levels for {on} — it has them only for models with reasoning variants. `/model` can switch to one that does.',
  effort_no_selector_agy:
    'agy offers no thinking level for {on} — it has one only for its Gemini models. `/model` can switch to one that does.',
  effort_no_selector_default: 'This agent offers no effort levels for {on}.',
  effort_start_failed: 'Could not start this agent, so its effort levels are unavailable:\n{reason}',
  effort_no_match: 'No effort level matches "{query}". Offered: {list}.',
  effort_ambiguous: '"{query}" could be {list} — type more of it.',
  effort_applied: 'Effort set to `{effort}` for this conversation, from the next message.',
  effort_unavailable:
    'This session offers no effort levels right now (its model may have changed). Run /effort again.',
  effort_missing:
    '`{value}` is no longer offered — the model\'s levels changed. Run /effort again for the current list.',
  effort_rebound:
    'This conversation is answered by {agent} now, so that menu no longer applies. Run /effort again.',
  effort_gone: 'That conversation is gone — send a message first, then /effort.',
  effort_failed: 'Could not set effort: {reason}',
  effort_expired:
    'That effort menu has expired (superseded, or the gateway restarted). Run /effort again for a fresh one.',
  effort_superseded: 'Effort: {current} — superseded by a newer /effort menu.',

  // Workdir menu
  workdir_menu_prev: '◀ Prev',
  workdir_menu_next: 'Next ▶',
  workdir_menu_text:
    'Working dir: {current}\n{count} available{pageNote} — tap one to work there (starts a fresh session), or `/cd <part of a name>`.',
  workdir_menu_page_note: ' · page {page}/{total}',
  workdir_summary_empty:
    'Working dir: {current}\nNothing else on offer — no sub-directories under the agent\'s root.',
  workdir_summary_list: 'Working dir: {current}\n{list}\n\nSwitching starts a fresh session there.',
  workdir_summary_more: '\n(+{truncated} more not shown — type part of a name to reach one.)',
  workdir_unreadable: 'Cannot list {root} ({reason}). Check `agents[].cwd` in config.yaml.',
  workdir_no_match: 'No directory matches "{query}". `/cd` alone lists what is on offer.',
  workdir_ambiguous: '"{query}" matches {count} directories:\n{list}{more}',
  workdir_ambiguous_more: '\n…and {count} more',
  workdir_applied:
    'Working in `{path}` now — fresh session; the previous context stayed behind.',
  workdir_unchanged: 'Already working in `{path}` — nothing reset.',
  workdir_missing: '`{path}` no longer exists. Run /cd again for the current list.',
  workdir_rebound:
    'This conversation is answered by {agent} now, so that menu no longer applies. Run /cd again.',
  workdir_failed: 'Could not switch directory: {reason}',
  workdir_expired:
    'That directory menu has expired (superseded, or the gateway restarted). Run /cd again for a fresh one.',
  workdir_superseded: 'Working dir: {current} — superseded by a newer /cd menu.',
  workdir_no_agent: 'No agent "{agentId}" is configured, so there is no directory to change.',

  // Skills catalog
  skills_catalog_header: '**{agentLabel}** has {count} {skillsWord}:',
  skills_word_single: 'skill',
  skills_word_plural: 'skills',
  skills_catalog_example: 'Type one with your request after it — e.g. `/{example} <what you want>`.',
  skills_empty_no_dir: '**{agentLabel}** has no skills directory this gateway knows how to read.',
  skills_empty_searched:
    '**{agentLabel}** has no skills installed.\n\nLooked in {where} for directories containing a `SKILL.md`.',

  // Permission & Elicitation prompt
  permission_prompt:
    '🔐 The agent asks to run:\n```\n{shown}\n```{change}\nNo answer within {minutes} min declines it.',
  permission_timeout_note:
    '⏱ Nobody answered — declined. The agent was told no one answered, not that you refused.',
  permission_no_buttons: '{platform} cannot show buttons',
  elicit_multi_hint: '_Tap to select as many as apply, then tap Done._',
  elicit_multi_empty:
    '_Nothing selected yet — tick at least one option, or type your own answer._',
  elicit_multi_degraded:
    '_This question takes more than one answer, which this platform cannot offer as buttons — tap the most important one, or type them all as a reply._',
  elicit_done_btn: '✅ Done',
  elicit_done_count_btn: '✅ Done ({count})',
  elicit_reminder_text: '⏱ Reminder: an unanswered question is still waiting above.',
  ask_outcome_timeout: '(timed out)',
  ask_outcome_replaced: '(replaced)',
  ask_outcome_answered: '→ Answered: {echo}',
  ask_outcome_selected: '→ Selected: {selection}',

  // Picker
  picker_no_commands:
    '▸ this conversation is now answered by {label}.\nNo command list from it yet — send it a message first, then /{cmd} again.',
  picker_none_beyond_menu: '{label} reports no commands beyond the ones already in the menu.',
  picker_prompt: '{label} commands:',
  picker_overflow: '\n\n{count} more (type them directly): {list}',
  picker_replaced: 'This menu was replaced by a newer one.',
  picker_expired:
    'That menu has expired (already used, replaced by a newer one, or the gateway restarted). Re-open it with the agent command (`/oc`, `/cc`, …), or /help for the full list.',
  picker_conv_gone: 'That conversation is gone — send a message first, then run /{name}.',

  // Conversation commands
  cmd_context_cleared: 'Context cleared — the next message starts a fresh conversation.',
  cmd_reload_unavailable: 'Reloading the config is not available in this daemon.',
  cmd_nested_unsupported:
    '/{command} works in the web UI only: its sub-agents open as topics nested under this one, and only the web UI can show them.',
  cmd_unsupported: '{name} does not support /{command}.{hint}',
  cmd_unsupported_hint: '\nIts own commands are available under /{own}.',
  cmd_btw_usage:
    'Usage: `/btw <question>` — asked of a copy of this conversation and answered on the side; the copy is then deleted, and a running turn carries on.',
  cmd_btw_words_only:
    '/btw takes a question in words only. Send pictures and files as an ordinary message.',
  cmd_btw_unsupported: '{name} does not support /btw.',
  cmd_context_no_numbers:
    'No context numbers yet — they arrive with the first reply. Send a message, then /context.',
  cmd_context_not_reported:
    'Context: not reported. {name} finished a turn without sending any usage numbers, and another message will not change that — a harness reports context only for a model whose window it knows.{fix}',
  cmd_context_left: '{tokens} left before compaction — {name}',
  cmd_harness_cli_outside: '{label} has no way to answer /{name} outside a turn.',
  cmd_harness_cli_failed: 'Could not ask {label} for /{name}: {error}',

  // Title
  title_not_named_yet: 'I have not named this topic yet — it gets a name after the next message.',
  title_released:
    'Forgot the name I gave this topic ("{current}"). It keeps that name until the next message, which will name it afresh.',
  title_not_named_prompt:
    'I have not named this topic. `/title <name>` to name it now, or it gets named automatically after the next message.',
  title_pinned_status:
    'This topic is named "{current}" — you set it, and it will not be renamed. `/title auto` to have it named afresh.',
  title_auto_status:
    'I named this topic "{current}" from its opening message, and will not rename it again. `/title <name>` to set your own.',
  title_failed: 'Could not rename this topic: {failure}',
  title_success: 'Renamed this topic to "{wanted}". `/title auto` to have it named automatically again.',
  title_err_platform: 'this platform cannot rename a conversation lane',
  title_err_no_thread: 'this conversation is not in a thread or topic, so there is no name to change',
  title_err_empty: 'that is an empty title',

  // Fork
  fork_web_only:
    '/fork works in the web UI only: the copy opens as a topic beside this one, and only the web UI has a topic list to put it in.',
  fork_nothing_yet: 'Nothing to fork yet: {label} has no conversation here. Send it a message first.',
  fork_unsupported: '{label} does not support /fork.',
  fork_failed: 'Could not fork: {reason}',
  fork_no_scope:
    "Could not fork: the new topic does not map to a conversation of its own under this deployment's scope.",
  fork_success:
    'Forked into {link}{at}: it carries on from everything said here so far, as a conversation of its own. This topic is unchanged.',
  fork_at_turn: ' at turn {turn}',
  fork_busy_turn:
    '{label} is in the middle of a turn here. /fork once it ends: a copy taken now would hold half of that turn.',
  fork_busy_background:
    '{label} is still reporting on background work here. /fork once it has finished.',
  fork_warn_raced:
    '⚠ {label} started a turn in the original topic while this copy was being made, so the copy may end part-way through that turn. If that matters, delete this topic and /fork again once the turn ends.',

  // Session options
  opt_start_failed: 'Could not start {agent} to ask for its settings:\n{error}',
  opt_none_to_change: '{agent} has no settings of its own to change.',
  opt_conv_gone: 'That conversation is gone — send a message first.',
  opt_no_longer_offered: '{agent} no longer offers that setting.',
  opt_value_no_longer_offered: '{name}: "{value}" is no longer offered.',
  opt_runtime_unsupported: '{agent} cannot change its settings at runtime.',
  opt_set_success: '{name} set to {choice} for this conversation.',

  // External calls
  ext_stopped_tasks: '⏹ Stopped {count} sub-agent{plural} under this topic.',
  ext_nothing_running: 'Nothing under this topic was running.',
  ext_topic_intercept:
    'This topic is **{caller}**\'s, a caller outside this gateway, and has no agent: nothing typed here reaches one. Tap Start or Cancel on its cards; write in a sub-task\'s own topic to talk to that agent; `/stop` stops every sub-task under this one.',
  ext_topic_intro:
    'Opened by **{caller}**, outside this gateway, through its MCP entrance. The sub-tasks it proposes appear here as cards, and none starts until you tap Start. Nothing typed here reaches an agent; `/stop` stops every sub-task under this one.',
} as const;

export const zhCN: DictOf<typeof en> = {
  // 命令描述
  cmd_desc_new: '开启新会话（清除当前上下文）',
  cmd_desc_clear: '/new 的别名：开启新会话',
  cmd_desc_stop: '停止当前轮次或后台任务（保留会话上下文）',
  cmd_desc_kill: '终止 Agent 进程（保留上下文；下一条消息自动恢复）',
  cmd_desc_cd: '选择工作目录（在目标目录开启新会话）',
  cmd_desc_agent: '选择响应此话题的 Agent（按机器分组）',
  cmd_desc_setting: '修改持久化配置（默认 Agent、模型、会话设置等）',
  cmd_desc_reload: '在不重启网关的情况下应用修改后的 config.yaml',
  cmd_desc_title: '为当前话题命名（未设置时将自动命名）',
  cmd_desc_fork: '将当前会话复刻为同级新话题（Web UI）',
  cmd_desc_skills: '列出当前 Agent 的专属技能与命令',
  cmd_desc_help: '列出此网关支持的所有命令',

  cmd_desc_compact: '压缩会话以释放上下文空间',
  cmd_desc_context: '查看当前上下文使用情况',
  cmd_desc_model: '查看或更改当前模型',
  cmd_desc_effort: '查看或更改思考程度',
  cmd_desc_usage: '查看 Token 使用量与配额限制',
  cmd_desc_doctor: '检查当前 Agent 的配置状态',
  cmd_desc_mcp: '管理 MCP 服务器',
  cmd_desc_init: '初始化本项目的 Agent 指导文件',
  cmd_desc_review: '审查当前代码更改',
  cmd_desc_super: '将任务并行拆分给多个子 Agent',
  cmd_arg_super_job: '要拆分的任务内容',
  cmd_desc_btw: '旁路提问：单独回答、不记入主会话、不中断主流程',
  cmd_arg_btw_question: '要提问的内容',

  cmd_use_agent: '使用 {target}',
  cmd_use_agent_picker: '使用 {target} — 单独发送可列出其专属命令',

  help_gateway_header: '**网关命令**',
  help_agents_header:
    '**Agent 命令** — `/<cmd> <prompt>` 提问；单独发送列出命令。会话锁定初始 Agent；发送 `/new` 重新选择',
  help_generic_header: '**当前 Agent 支持的命令**',
  help_answering_now: '当前应答：**{target}**',

  unconfigured_harness:
    '当前未配置 {missing} Agent，因此 /{missing} 未选中任何项。请在 config.yaml 的 `agents:` 下添加（`harness: {missing}`）并发送 /reload；发送 /help 可查看当前网关已有的 Agent。',

  // Agent 菜单
  agent_menu_which_machine: '选择哪台机器？{current}',
  agent_menu_now: ' (当前: {current})',
  agent_menu_back_machines: '‹ 机器列表',
  agent_menu_offline_note: '离线',
  agent_menu_offline_warning: '\n{name} 当前处于离线状态：在其恢复连接前，所属 Agent 无法响应。',
  agent_menu_retry_question: '使用哪个 Agent 重试{where}？',
  agent_menu_answer_question: '由哪个 Agent 响应此话题{where}？',
  agent_menu_where: ' 在 {name} 上',
  agent_list_header: '可选 Agent（通过 `/agent <id>` 为此话题选择）：',
  agent_list_offline_banner: '({name} 处于离线状态)',
  agent_match_none: '没有匹配 "{query}" 的 Agent。\n{list}',
  agent_match_many: '"{query}" 匹配到多个 Agent：{ids} — 请选择哪一个？',
  agent_bound_ack: '▸ 当前会话现已由 {name} 响应 — 直接输入即可继续',

  // 模型菜单
  model_menu_prev: '◀ 上一页',
  model_menu_next: '下一页 ▶',
  model_menu_text:
    '模型: {current}\n共 {count} 个可用{pageNote} — 点击选择，或输入 `/model <名称片段>`。',
  model_menu_page_note: ' · 第 {page}/{total} 页',
  model_menu_unknown: '未知',
  model_summary_text:
    '模型: {current}\n共 {count} 个可用 — 输入 `/model <名称片段>` 切换（例如 `/model sonnet`）。',
  model_no_selector:
    '该 Agent 未提供模型选择器 — 不支持在运行时更改模型。请在 config.yaml 中设置 `agents[].model`（或对应的环境变量，如 ANTHROPIC_MODEL）并发送 /reload 更改。',
  model_start_failed: '无法启动该 Agent，模型列表不可用：\n{reason}',
  model_no_match: '没有匹配 "{query}" 的模型。单独发送 `/model` 可查看当前模型及可用列表。',
  model_ambiguous: '"{query}" 匹配到 {count} 个模型：\n{list}{more}',
  model_ambiguous_more: '\n…还有 {count} 个',
  model_applied: '当前会话模型已切换为 `{model}`。',
  model_unavailable:
    '当前没有运行中的会话可供切换 — 会话将在下一条消息发送时启动。请先发送一条消息，然后再使用 /model。',
  model_missing: '该 Agent 已不再提供 `{value}`。请重新运行 /model 查看最新列表。',
  model_rebound: '当前会话已改由 {agent} 响应，该菜单已失效。请重新运行 /model。',
  model_gone: '该会话已不存在 — 请先发送消息，然后再使用 /model。',
  model_failed: '无法切换模型：{reason}',
  model_expired: '该模型菜单已过期（已被新菜单取代，或网关已重启）。请重新运行 /model 获取新菜单。',
  model_superseded: '模型: {current} — 已被更新的 /model 菜单取代。',

  // 思考程度菜单
  effort_menu_text: '思考程度: {current}\n点击选择，或输入 `/effort <级别>`。',
  effort_summary_text: '思考程度: {current}\n可选级别: {list} — 输入 `/effort <级别>` 切换。',
  effort_on_current_model: '当前模型',
  effort_no_selector_codex:
    'Codex 未为 {on} 提供思考程度选项。Codex 的级别来自于其自身模型目录，而当前安装的 codex-cli 未包含该模型（更新版本的 codex-cli 可能会支持）。可通过 `/model` 切换到其已知的模型；在此之前级别由 ~/.codex/config.toml 中的 `model_reasoning_effort` 决定。',
  effort_no_selector_opencode:
    'OpenCode 未为 {on} 提供思考程度选项 — 仅支持具备思考变体的模型。可通过 `/model` 切换到支持的模型。',
  effort_no_selector_agy:
    'agy 未为 {on} 提供思考程度选项 — 仅 Gemini 系列模型支持。可通过 `/model` 切换到支持的模型。',
  effort_no_selector_default: '该 Agent 未为 {on} 提供思考程度选项。',
  effort_start_failed: '无法启动该 Agent，思考程度选项不可用：\n{reason}',
  effort_no_match: '没有匹配 "{query}" 的思考程度级别。可选级别: {list}。',
  effort_ambiguous: '"{query}" 可能是 {list} — 请输入更完整的名称。',
  effort_applied: '当前会话思考程度已设置为 `{effort}`，将从下一条消息起生效。',
  effort_unavailable: '当前会话暂未提供思考程度选项（模型可能已变更）。请重新运行 /effort。',
  effort_missing: '不再提供 `{value}` — 模型的可用级别已变更。请重新运行 /effort 查看最新列表。',
  effort_rebound: '当前会话已改由 {agent} 响应，该菜单已失效。请重新运行 /effort。',
  effort_gone: '该会话已不存在 — 请先发送消息，然后再使用 /effort。',
  effort_failed: '无法设置思考程度：{reason}',
  effort_expired: '该思考程度菜单已过期（已被新菜单取代，或网关已重启）。请重新运行 /effort 获取新菜单。',
  effort_superseded: '思考程度: {current} — 已被更新的 /effort 菜单取代。',

  // 工作目录菜单
  workdir_menu_prev: '◀ 上一页',
  workdir_menu_next: '下一页 ▶',
  workdir_menu_text:
    '工作目录: {current}\n共 {count} 个可用{pageNote} — 点击选择在此工作（将启动新会话），或输入 `/cd <名称片段>`。',
  workdir_menu_page_note: ' · 第 {page}/{total} 页',
  workdir_summary_empty: '工作目录: {current}\n没有其他可选目录 — Agent 根目录下无子目录。',
  workdir_summary_list: '工作目录: {current}\n{list}\n\n切换目录将在此处启动新会话。',
  workdir_summary_more: '\n（另有 {truncated} 个未展示 — 输入部分名称即可选中）',
  workdir_unreadable: '无法列出目录 {root}（{reason}）。请检查 config.yaml 中的 `agents[].cwd`。',
  workdir_no_match: '没有匹配 "{query}" 的目录。单独发送 `/cd` 可列出可用目录。',
  workdir_ambiguous: '"{query}" 匹配到 {count} 个目录：\n{list}{more}',
  workdir_ambiguous_more: '\n…还有 {count} 个',
  workdir_applied:
    '已切换至目录 `{path}` 工作 — 新会话已启动，之前的上下文已保留在原目录。',
  workdir_unchanged: '当前已在目录 `{path}` 工作 — 会话未重置。',
  workdir_missing: '目录 `{path}` 已不存在。请重新运行 /cd 查看最新列表。',
  workdir_rebound: '当前会话已改由 {agent} 响应，该菜单已失效。请重新运行 /cd。',
  workdir_failed: '无法切换工作目录：{reason}',
  workdir_expired: '该目录菜单已过期（已被新菜单取代，或网关已重启）。请重新运行 /cd 获取新菜单。',
  workdir_superseded: '工作目录: {current} — 已被更新的 /cd 菜单取代。',
  workdir_no_agent: '未配置名为 "{agentId}" 的 Agent，没有可更改的目录。',

  // 技能列表
  skills_catalog_header: '**{agentLabel}** 拥有 {count} {skillsWord}：',
  skills_word_single: '个技能',
  skills_word_plural: '个技能',
  skills_catalog_example: '输入技能名称并在其后附带请求 — 例如 `/{example} <你的需求>`.',
  skills_empty_no_dir: '**{agentLabel}** 没有此网关可读取的技能目录。',
  skills_empty_searched:
    '**{agentLabel}** 未安装任何技能。\n\n已在 {where} 中查找包含 `SKILL.md` 的目录。',

  // 权限与提问
  permission_prompt:
    '🔐 Agent 请求执行以下操作：\n```\n{shown}\n```{change}\n若 {minutes} 分钟内未回复将自动拒绝。',
  permission_timeout_note: '⏱ 超时未作回复 — 已自动拒绝。系统已告知 Agent 超时未获回复，而非你主动拒绝。',
  permission_no_buttons: '{platform} 无法显示按钮',
  elicit_multi_hint: '_点击选择所有适用的选项，然后点击“完成”。_',
  elicit_multi_empty: '_尚未选择任何选项 — 请至少勾选一项，或直接回复你的答案。_',
  elicit_multi_degraded:
    '_此问题支持多选，但当前平台无法以按钮形式提供多选 — 请点击最重要的一项，或以回复形式发送全部答案。_',
  elicit_done_btn: '✅ 完成',
  elicit_done_count_btn: '✅ 完成 ({count})',
  elicit_reminder_text: '⏱ 提醒：上方仍有待回复的问题。',
  ask_outcome_timeout: '(已超时)',
  ask_outcome_replaced: '(已替换)',
  ask_outcome_answered: '→ 已回复：{echo}',
  ask_outcome_selected: '→ 已选择：{selection}',

  // 选择器
  picker_no_commands:
    '▸ 当前会话已改由 {label} 响应。\n暂未获取到其命令列表 — 请先向其发送一条消息，然后再使用 /{cmd}。',
  picker_none_beyond_menu: '{label} 未报告菜单之外的其他命令。',
  picker_prompt: '{label} 命令列表：',
  picker_overflow: '\n\n还有 {count} 个（可直接输入）：{list}',
  picker_replaced: '该菜单已被新菜单取代。',
  picker_expired:
    '该菜单已过期（已使用、已被新菜单取代，或网关已重启）。请使用 Agent 命令（`/oc`、`/cc`…）重新打开，或发送 /help 查看完整列表。',
  picker_conv_gone: '该会话已不存在 — 请先发送消息，然后再运行 /{name}。',

  // 会话命令
  cmd_context_cleared: '上下文已清除 — 下一条消息将开启新会话。',
  cmd_reload_unavailable: '此网关未启用配置重载。',
  cmd_nested_unsupported:
    '/{command} 仅在 Web UI 中可用：其子 Agent 会作为嵌套于此话题下的子话题开启，目前仅 Web UI 支持展示。',
  cmd_unsupported: '{name} 不支持 /{command}。{hint}',
  cmd_unsupported_hint: '\n其专属命令可在 /{own} 下查看。',
  cmd_btw_usage:
    '用法：`/btw <问题>` — 会在当前会话的副本中提问并在旁路回复；回复后副本将被销毁，不会影响或中断主会话中正在进行的轮次。',
  cmd_btw_words_only: '/btw 仅接受文字提问。图片和文件请作为普通消息发送。',
  cmd_btw_unsupported: '{name} 不支持 /btw。',
  cmd_context_no_numbers:
    '暂无上下文统计数据 — 数据随首次回复返回。请先发送一条消息，然后再使用 /context。',
  cmd_context_not_reported:
    '上下文：未报告。{name} 完成了一轮对话但未返回任何使用量统计，再次发送消息也不会改变 — 框架仅对已知上下文窗口大小的模型报告上下文使用量。{fix}',
  cmd_context_left: '距离压缩还剩 {tokens} — {name}',
  cmd_harness_cli_outside: '{label} 无法在对话轮次之外响应 /{name}。',
  cmd_harness_cli_failed: '无法向 {label} 请求 /{name}：{error}',

  // 标题
  title_not_named_yet: '我尚未命名此话题 — 将在下一条消息发送后自动命名。',
  title_released:
    '已清除为此话题设置的名称（"{current}"）。在下一条消息发送前将保持该名称，之后将重新自动命名。',
  title_not_named_prompt:
    '我尚未命名此话题。输入 `/title <名称>` 立即命名，或在下一条消息发送后自动命名。',
  title_pinned_status:
    '此话题已被命名为 "{current}" — 由你手动设置，不会被自动重命名。输入 `/title auto` 可恢复自动命名。',
  title_auto_status:
    '我根据开场消息将此话题命名为 "{current}"，不会再次自动重命名。输入 `/title <名称>` 可设置你自定义的名称。',
  title_failed: '无法重命名此话题：{failure}',
  title_success: '已将此话题重命名为 "{wanted}"。输入 `/title auto` 可恢复自动命名。',
  title_err_platform: '当前平台不支持重命名会话通道',
  title_err_no_thread: '此会话不在线程或话题中，没有可修改的名称',
  title_err_empty: '标题不能为空',

  // 复刻
  fork_web_only:
    '/fork 仅在 Web UI 中可用：副本将作为新话题创建在此话题旁，目前仅 Web UI 拥有话题列表展示。',
  fork_nothing_yet: '暂无内容可复刻：{label} 在此尚无会话。请先向其发送一条消息。',
  fork_unsupported: '{label} 不支持 /fork。',
  fork_failed: '无法复刻：{reason}',
  fork_no_scope: "无法复刻：在当前部署的作用域下，新话题未能映射到其独立的会话。",
  fork_success:
    '已复刻至 {link}{at}：它将承接此话题至今的全部内容作为独立会话继续。当前话题保持不变。',
  fork_at_turn: '（于第 {turn} 轮）',
  fork_busy_turn:
    '{label} 正在执行本轮对话。请在结束后使用 /fork：现在复刻可能会捕获到不完整的轮次。',
  fork_busy_background:
    '{label} 仍在此汇报后台任务。请在完成后使用 /fork。',
  fork_warn_raced:
    '⚠ 在创建副本的过程中，{label} 在原话题中开启了新一轮对话，因此副本可能只截取到了该轮次的部分内容。如需完整内容，可删除此话题并在原话题对话结束后重新运行 /fork。',

  // 会话选项
  opt_start_failed: '无法启动 {agent} 以获取其设置：\n{error}',
  opt_none_to_change: '{agent} 没有专属设置可更改。',
  opt_conv_gone: '该会话已不存在 — 请先发送一条消息。',
  opt_no_longer_offered: '{agent} 已不再提供该设置项。',
  opt_value_no_longer_offered: '{name}：“{value}”已不再提供。',
  opt_runtime_unsupported: '{agent} 无法在运行时更改设置。',
  opt_set_success: '当前会话的 {name} 已设置为 {choice}。',

  // 外部调用
  ext_stopped_tasks: '⏹ 已停止该话题下的 {count} 个子 Agent。',
  ext_nothing_running: '该话题下没有正在运行的任务。',
  ext_topic_intercept:
    '此话题由网关外部调用者 **{caller}** 创建，未绑定任何 Agent：此处输入的文字不会发送给任何 Agent。请在其卡片上点击“开始”或“取消”；在子任务各自的话题中发言可与对应 Agent 交流；发送 `/stop` 可停止此话题下的所有子任务。',
  ext_topic_intro:
    '由网关外部调用者 **{caller}** 通过 MCP 入口创建。其提议的子任务将以卡片形式呈现在此处，只有在你点击“开始”后才会启动。此处输入的文字不会发送给任何 Agent；发送 `/stop` 可停止此话题下的所有子任务。',
};

export type MenusMessageKey = keyof typeof en;

export const tMenus: DomainTranslator<MenusMessageKey> = createTranslator({
  en,
  'zh-CN': zhCN,
});
