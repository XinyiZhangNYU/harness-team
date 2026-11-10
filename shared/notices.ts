/**
 * Translatable text the server writes into the chat: system notices, session info, tool activity titles and approval
 * titles. The server stores the Chinese rendering as the message body (what agents read and what older clients show)
 * and the code + params in the message meta, so the web UI can show the same text in the user's language.
 *
 * Templates use `{name}` placeholders. A param is a plain value, a nested NoticeText (rendered in the same language),
 * a list of strings (joined with 、 / ", "), a list of NoticeTexts (joined with ； / "; ") or `{ lines }` (one per line).
 * A missing param renders as nothing, so optional fragments are simply left out.
 *
 * Besides the coded templates below, `L(zh, en, params)` carries a one-off text with both languages inline (used for
 * error messages and other text that is not stored in the chat).
 */

export type NoticeValue = string | number | NoticeText | string[] | NoticeText[] | { lines: NoticeText[] };

export type NoticeText =
  | { code: NoticeCode; params?: Record<string, NoticeValue | null | undefined> }
  | { zh: string; en: string; params?: Record<string, NoticeValue | null | undefined> };

export type NoticeLang = 'zh' | 'en';

const T = {
  // ---- small fragments ----
  'fmt.paren': { zh: '（{x}）', en: ' ({x})' },
  'word.default': { zh: '默认', en: 'default' },
  'word.followDefault': { zh: '跟随默认', en: 'default' },
  'word.none': { zh: '无', en: 'none' },
  'word.user': { zh: '用户', en: 'You' },
  'word.resume': { zh: '恢复', en: 'resumed' },
  'word.create': { zh: '新建', en: 'created' },
  'billing.metered_api': { zh: '按量计费', en: 'metered API' },

  // ---- rooms and collaboration ----
  'room.paused': {
    zh: '用户已暂停自动协作：Agent 之间的消息将保留不投递{held}。正在进行的回合不受影响；用户 @ 的消息照常投递。',
    en: 'You paused auto-collaboration: messages between agents are held{held}. Turns already running are not affected; messages you @mention are delivered as usual.',
  },
  'room.pausedHeld': { zh: '（已保留 {n} 条待投递消息）', en: ' ({n} queued messages held)' },
  'room.resumed': { zh: '用户已恢复自动协作{released}。', en: 'You resumed auto-collaboration{released}.' },
  'room.resumedReleased': { zh: '，释放 {n} 条保留的消息', en: '; {n} held messages released' },
  'delivery.outsideTurn': {
    zh: '#{seq} 是在回合之外发出的，不会自动投递给 {who}；需要时请由你 @ 对方。',
    en: '#{seq} was sent outside a turn, so it is not delivered to {who} automatically; @mention them yourself if needed.',
  },
  'delivery.hopLimit': {
    zh: '自动协作已达到上限（连续 {limit} 次 Agent 之间的自动唤醒）：#{seq} 未自动投递给 {who}。用户发言后重新计数，也可以在群聊顶部调整接力上限。',
    en: 'Auto-collaboration reached its limit ({limit} agent-to-agent wake-ups in a row): #{seq} was not delivered to {who}. The count restarts when you post; you can also change the relay limit at the top of the chat.',
  },
  'delivery.restricted': {
    zh: 'Antigravity 受限模式：#{seq} 未自动投递给 {who}。受限模式下只有用户 @ 能唤醒 Antigravity，它的发言也不会自动唤醒其他成员。',
    en: 'Antigravity restricted mode: #{seq} was not delivered to {who} automatically. In restricted mode only you can wake Antigravity with an @mention, and what it says does not wake other members.',
  },
  'delivery.chatGate': {
    zh: '#{seq} 未自动投递给 {who}：聊天成员只能唤醒你在本群 @ 过的编程成员。需要时请由你 @ 对方一次。',
    en: '#{seq} was not delivered to {who}: chat members can only wake coding members you have @mentioned in this chat. @mention them once yourself if needed.',
  },
  'delivery.held': {
    zh: '自动协作已暂停：#{seq} 发给 {who} 的消息已保留，恢复后投递。',
    en: 'Auto-collaboration is paused: #{seq} to {who} is held and will be delivered when you resume.',
  },

  // ---- members ----
  'agent.collabFull': {
    zh: '@{handle} 已切换为完整协作模式（用户已确认风险提示）：可参与自动接力和 Team MCP 写操作；原生权限请求仍需人工批准。',
    en: '@{handle} switched to full collaboration mode (you confirmed the risk warning): it takes part in auto-relay and Team MCP writes; native permission requests still need your approval.',
  },
  'agent.collabRestricted': {
    zh: '@{handle} 已切换为受限模式：只有用户 @ 能唤醒它，Team MCP 仅可读取；尚未投递的 Agent 之间消息已标记为跳过。原生会话保持不变。',
    en: '@{handle} switched to restricted mode: only you can wake it with an @mention and Team MCP is read-only; undelivered agent-to-agent messages were marked skipped. The native session is kept.',
  },
  'team.assignRestricted': {
    zh: '@{handle} 处于 Antigravity 受限模式：只有用户能给它分配工作，任务未修改。',
    en: '@{handle} is in Antigravity restricted mode: only the user can give it work. The task was not changed.',
  },
  'team.readOnly': {
    zh: '受限模式下 Team MCP 仅可读取：不能发消息或修改任务。需要时请让用户在成员设置中启用完整协作模式。',
    en: 'In restricted mode Team MCP is read-only: you cannot send messages or change tasks. Ask the user to enable full collaboration mode in member settings if needed.',
  },
  'agent.configSaved': {
    zh: '@{handle} 的配置已保存（模型：{model} · Effort：{effort} · 权限模式：{perm}）。{when}，继续使用同一原生会话。',
    en: '@{handle}’s settings were saved (model: {model} · effort: {effort} · permission mode: {perm}). {when}, in the same native session.',
  },
  // Permission modes (Agent.permissionMode). The native name stays visible so it can be matched with the runtime's own docs.
  'perm.follow': { zh: '跟随我的设置', en: 'Follow my settings' },
  'perm.manual': { zh: '每次确认（manual）', en: 'Ask every time (manual)' },
  'perm.acceptEdits': { zh: '自动接受编辑（acceptEdits）', en: 'Accept edits (acceptEdits)' },
  'perm.plan': { zh: '只规划（plan）', en: 'Plan only (plan)' },
  'perm.auto': { zh: '自动判断（auto）', en: 'Auto (auto)' },
  'perm.read-only': { zh: '只读（read-only）', en: 'Read-only (read-only)' },
  'perm.workspace-write': { zh: '工作区可写（workspace-write · on-request）', en: 'Workspace write (workspace-write · on-request)' },
  'perm.untrusted': { zh: '更严格（untrusted）', en: 'Stricter (untrusted)' },
  'perm.dontAsk': { zh: '不询问，未预先允许的直接拒绝（dontAsk）', en: 'Don’t ask, refuse what is not allowed (dontAsk)' },
  'perm.bypassPermissions': { zh: '跳过所有审批（bypassPermissions）', en: 'Skip all approvals (bypassPermissions)' },
  'perm.auto-review': { zh: '自动审批（auto-review）', en: 'Auto-review (auto-review)' },
  'perm.full-access': { zh: '完全访问（danger-full-access · never）', en: 'Full access (danger-full-access · never)' },
  // dsh shares Codex's mode ids but has no approval policy: only its preset name (DSH_PERMISSION_MODE) is shown.
  'perm.dsh.workspace-write': { zh: '工作区可写（workspace-write）', en: 'Workspace write (workspace-write)' },
  'perm.dsh.full-access': { zh: '完全访问（danger-full-access）', en: 'Full access (danger-full-access)' },
  'perm.default': { zh: '默认（default）', en: 'Default (default)' },
  'perm.build': { zh: '构建（build）', en: 'Build (build)' },
  'perm.accept-edits': { zh: '自动接受编辑（accept-edits）', en: 'Accept edits (accept-edits)' },
  'perm.skip-permissions': { zh: '跳过所有审批（--dangerously-skip-permissions）', en: 'Skip all approvals (--dangerously-skip-permissions)' },
  'agent.applyAfterTurn': {
    zh: '当前回合不受影响（不会中断回合或工具），将从本回合结束后的下一回合起生效',
    en: 'The current turn is not affected (no turn or tool is interrupted); they apply from the turn after it',
  },
  'agent.applyNext': { zh: '将从下一回合起生效', en: 'They apply from the next turn' },
  'agent.removed': {
    zh: '@{handle} 已移出群聊。之后再加入时会继续原来的原生会话。',
    en: '@{handle} was removed from the chat. If added again, it continues its original native session.',
  },
  'agent.deleted': { zh: '成员 {name}（@{handle}）已删除。', en: 'Member {name} (@{handle}) was deleted.' },

  // ---- tasks ----
  'task.created': { zh: '{actor} 创建了任务 #{id}「{title}」{assignee}', en: '{actor} created task #{id} “{title}”{assignee}' },
  'task.assignee': { zh: '，负责人 @{handle}', en: ', assigned to @{handle}' },
  'task.updated': { zh: '{actor} 更新了任务 #{id}「{title}」：{changes}', en: '{actor} updated task #{id} “{title}”: {changes}' },
  'task.changeStatus': { zh: '状态 {from} → {to}', en: 'status {from} → {to}' },
  'task.changeAssignee': { zh: '负责人 {from} → {to}', en: 'assignee {from} → {to}' },
  'task.changeTitle': { zh: '标题改为「{title}」', en: 'renamed to “{title}”' },

  // ---- turns ----
  'turn.settled': {
    zh: '@{handle} 的上一回合已由运行时确认结束{released}，可继续派发。',
    en: 'The runtime confirmed @{handle}’s previous turn has ended{released}; messages can be dispatched again.',
  },
  'turn.settledReleased': { zh: '，工作目录已释放', en: ' and its folder is free again' },
  'turn.unsettled': {
    zh: '@{handle} 的原生回合尚未被运行时确认结束（可能仍在运行）。在确认结束（或运行时进程退出）之前，{folder}不会向该成员或同一工作目录的其他成员派发新任务。',
    en: 'The runtime has not confirmed that @{handle}’s native turn ended (it may still be running). Until it does (or the runtime process exits), {folder}no new work goes to this member or to others in the same folder.',
  },
  'turn.unsettledFolder': { zh: '工作目录 {path} 保持占用，', en: 'the folder {path} stays taken and ' },
  'turn.failed': { zh: '运行失败：{error}', en: 'Run failed: {error}' },
  'turn.noText': { zh: '（本轮没有文字输出）', en: '(No text output this turn)' },
  'command.done': { zh: '已执行 /{name}', en: 'Ran /{name}' },
  'turn.mismatch': { zh: '⚠ {text}', en: '⚠ {text}' },
  'workspace.wait': {
    zh: '@{me} 与 @{holder} 使用同一工作目录（{path}），将在对方当前回合结束后再开始（同一目录默认顺序执行）。可中断 @{me} 取消等待。',
    en: '@{me} and @{holder} share the folder {path}; @{me} starts after @{holder}’s current turn ends (one turn at a time per folder). Interrupt @{me} to cancel the wait.',
  },
  'workspace.waitCancelled': {
    zh: '已取消 @{handle} 的等待：{n} 条消息未派发给运行时。',
    en: 'Stopped @{handle}’s wait: {n} message(s) were not sent to the runtime.',
  },

  // ---- sessions ----
  'session.lost': {
    zh: '@{handle} 的原生会话 `{id}` 无法恢复（{error}）。已标记为丢失，并为该成员新建会话；旧会话的上下文不会带入。',
    en: '@{handle}’s native session `{id}` could not be resumed ({error}). It is marked lost and a new session was started; the old context is not carried over.',
  },
  'session.choiceArchived': {
    zh: '@{handle} 的 {runtime} 对话已在 {runtime} 应用里归档，无法续接。发给 @{handle} 的消息会先等待，请选择：恢复原对话（在 {runtime} 里取消归档，上下文保留），或新开会话（之前的上下文不会带入）。\n会话 ID：{id}\n原因：{error}',
    en: '@{handle}’s {runtime} conversation was archived in the {runtime} app, so it cannot be continued. Messages to @{handle} wait until you choose: restore it (unarchives it in {runtime} and keeps the context) or start a new session (the earlier context is not carried over).\nSession ID: {id}\nReason: {error}',
  },
  'session.choiceMissing': {
    zh: '@{handle} 的 {runtime} 会话已不存在（可能已在 {runtime} 里删除），无法恢复。发给 @{handle} 的消息会先等待，新开会话后发出；新会话没有之前的上下文，但会被告知可以查看群聊记录。\n会话 ID：{id}\n原因：{error}',
    en: '@{handle}’s {runtime} session no longer exists (it may have been deleted in {runtime}) and cannot be restored. Messages to @{handle} wait and are sent once you start a new session; it has none of the earlier context but is told it can read the chat history.\nSession ID: {id}\nReason: {error}',
  },
  'session.choiceOther': {
    zh: '@{handle} 的 {runtime} 会话暂时无法续接。发给 @{handle} 的消息会先等待，请选择：重试，或新开会话（之前的上下文不会带入）。\n会话 ID：{id}\n原因：{error}',
    en: '@{handle}’s {runtime} session cannot be continued right now. Messages to @{handle} wait until you choose: retry, or start a new session (the earlier context is not carried over).\nSession ID: {id}\nReason: {error}',
  },
  'session.choiceUnknown': { zh: '上次续接失败（程序重启前）', en: 'resuming failed before the app restarted' },
  'err.sessionChoiceNotFound': { zh: '找不到这条会话选择', en: 'This session choice was not found' },
  'err.sessionChoiceDone': { zh: '已经选择过了', en: 'Already decided' },
  'err.sessionChoiceOption': { zh: '这里不能选「{choice}」', en: '“{choice}” is not an option here' },
  'err.sessionChoiceStale': {
    zh: '这条提示已过期：成员已删除，或会话已经换过。',
    en: 'This notice is out of date: the member was removed or the session has changed since.',
  },
  'err.sessionRestoreFailed': { zh: '恢复失败：{error}', en: 'Could not restore it: {error}' },
  'session.info': { zh: '@{handle} 会话信息\n{lines}', en: '@{handle} session info\n{lines}' },
  'session.id': { zh: '会话 ID：{id}', en: 'Session ID: {id}' },
  'session.cwd': { zh: '工作目录：{path}', en: 'Folder: {path}' },
  'session.instructions': { zh: '项目/用户指令：{list}', en: 'Project/user instructions: {list}' },
  'codex.threadNew': { zh: '已新建 Codex 线程', en: 'New Codex thread' },
  'codex.threadResumed': { zh: '已恢复 Codex 线程', en: 'Resumed Codex thread' },
  'codex.model': { zh: '模型：{model}{effort}', en: 'Model: {model}{effort}' },
  'codex.sandbox': { zh: '沙箱：{type}{net}{roots}', en: 'Sandbox: {type}{net}{roots}' },
  'codex.sandboxNet': { zh: '（可联网）', en: ' (network access on)' },
  'codex.sandboxRoots': { zh: '，额外可写：{list}', en: ', also writable: {list}' },
  'codex.policy': { zh: '审批策略：{policy} · 审批人：{reviewer}', en: 'Approval policy: {policy} · reviewer: {reviewer}' },
  'codex.restarted': { zh: 'codex app-server 已重启，已按 id 恢复线程 {id}', en: 'codex app-server restarted; thread {id} was resumed by id' },
  'codex.defaultsUnreadable': {
    zh: '无法读取 Codex 默认配置（{error}），本回合沿用线程当前设置 {model}',
    en: 'Could not read the Codex defaults ({error}); this turn keeps the thread’s current setting {model}',
  },
  'codex.interruptFailed': { zh: 'turn/interrupt 请求失败：{error}', en: 'turn/interrupt request failed: {error}' },
  'codex.retrying': { zh: 'Codex 报错，正在重试：{error}', en: 'Codex error, retrying: {error}' },
  'codex.warning': { zh: 'Codex 警告：{message}', en: 'Codex warning: {message}' },
  'codex.autoReview.approved': { zh: 'Codex 审核代理已批准（风险：{risk}）：{action}。理由：{rationale}', en: 'Codex auto-review approved (risk: {risk}): {action}. Reason: {rationale}' },
  'codex.autoReview.denied': { zh: 'Codex 审核代理已拒绝（风险：{risk}）：{action}。理由：{rationale}', en: 'Codex auto-review denied (risk: {risk}): {action}. Reason: {rationale}' },
  'codex.autoReview.timedOut': { zh: 'Codex 审核代理超时，未批准：{action}', en: 'Codex auto-review timed out, not approved: {action}' },
  'codex.autoReview.aborted': { zh: 'Codex 审核代理中止，未批准：{action}', en: 'Codex auto-review aborted, not approved: {action}' },

  'claude.sessionNew': { zh: '已新建 Claude Code 会话', en: 'New Claude Code session' },
  'claude.sessionResumed': { zh: '已恢复 Claude Code 会话', en: 'Resumed Claude Code session' },
  'claude.backend': {
    zh: '后端：{backend}（官方 Claude Code {version}，-p stream-json，未修改）',
    en: 'Backend: {backend} (official Claude Code {version}, -p stream-json, unmodified)',
  },
  'claude.authSub': {
    zh: '认证：claude.ai 订阅（{plan} · {provider}）',
    en: 'Auth: claude.ai subscription ({plan} · {provider})',
  },
  'claude.authOwn': { zh: '认证：Claude Code 自己的登录（{source}），按 token 计费', en: 'Auth: Claude Code’s own login ({source}), billed per token' },
  'claude.modelLine': {
    zh: '模型：{model}{effort}{args} · 权限模式：{mode}（Claude Code 原生规则；需确认的工具请求送到群聊，只有用户在群内点选才会批准，Harness Team 从不自动批准）',
    en: 'Model: {model}{effort}{args} · permission mode: {mode} (Claude Code’s own rules; tool requests that need a decision come to the chat, and only your click there approves them; Harness Team never approves on its own)',
  },
  'claude.effort': { zh: '（Effort {effort}）', en: ' (effort {effort})' },
  'claude.modelArgs': { zh: '（--{args}）', en: ' (--{args})' },
  'claude.modelDefault': { zh: '（跟随 Claude Code 默认配置）', en: ' (Claude Code’s default)' },
  'claude.attachRule': {
    zh: '附件：可直接读取本群附件目录 {dir}（只读，`--allowedTools {rule}`；你自己的 deny / ask 规则仍优先）',
    en: 'Attachments: may read this chat’s attachment folder {dir} without asking (read-only, `--allowedTools {rule}`; your own deny / ask rules still win)',
  },
  'claude.attachNoRule': {
    zh: '附件：本群附件目录 {dir} 无法写成精确的只读规则（路径含特殊字符或不是本地绝对路径），读取附件仍按 Claude Code 原生规则审批',
    en: 'Attachments: the attachment folder {dir} cannot be written as an exact read-only rule (special characters, or not a local absolute path); reading attachments follows Claude Code’s own approval rules',
  },
  'claude.ready': {
    zh: 'Claude Code {version} 已就绪 · 模型 {model} · {source}\n{lines}',
    en: 'Claude Code {version} ready · model {model} · {source}\n{lines}',
  },
  'claude.sourceSub': { zh: '订阅登录', en: 'subscription login' },
  'claude.sourceOther': { zh: '认证来源 {source}', en: 'auth source {source}' },
  'claude.initMode': { zh: '权限模式 {mode} · apiKeySource={source}', en: 'Permission mode {mode} · apiKeySource={source}' },
  'claude.initCounts': {
    zh: '工具 {tools} 个 · 插件 {plugins} 个 · 子代理 {agents} 个 · 斜杠命令 {commands} 个',
    en: '{tools} tools · {plugins} plugins · {agents} subagents · {commands} slash commands',
  },
  'claude.initMcp': { zh: 'MCP：{list}', en: 'MCP: {list}' },
  'claude.initSkills': { zh: 'Skills（{n}）：{list}', en: 'Skills ({n}): {list}' },
  'claude.untrusted': {
    zh: 'Claude Code 未应用本项目 .claude/settings.json 中的{count} permissions.allow 规则：该工作区尚未被信任，相关工具调用都会走原生审批。如需启用，请你自己在该目录交互式运行一次 `claude` 并接受信任对话框（Harness Team 不会代为信任或修改 ~/.claude.json）。',
    en: 'Claude Code did not apply{count} permissions.allow rules from this project’s .claude/settings.json: the folder is not trusted yet, so those tool calls go through native approval. To enable them, run `claude` interactively in that folder yourself and accept the trust dialog (Harness Team never trusts folders or edits ~/.claude.json for you).',
  },
  'claude.untrustedCount': { zh: ' {n} 条', en: ' {n}' },
  'claude.restartedConfig': {
    zh: '已按新配置（模型：{model} · Effort：{effort} · 权限模式：{perm}）重启 claude 进程，并按 id {how}同一会话 {id}',
    en: 'Restarted the claude process with the new settings (model: {model} · effort: {effort} · permission mode: {perm}); the same session {id} was {how} by id',
  },
  'claude.restarted': { zh: 'claude 进程已重新启动，并按 id {how}会话 {id}', en: 'The claude process restarted; session {id} was {how} by id' },
  'claude.interruptFailed': { zh: '中断请求失败：{error}', en: 'Interrupt request failed: {error}' },
  'claude.compacted': { zh: 'Claude Code 已压缩上下文', en: 'Claude Code compacted the context' },
  'claude.retrying': { zh: 'Claude Code 正在重试请求（{detail}）', en: 'Claude Code is retrying the request ({detail})' },
  'claude.quotaReached': {
    zh: 'Claude 订阅额度已达上限（{type}{reset}）。Harness Team 不会切换到 API Key 或其他付费方式。',
    en: 'Claude subscription limit reached ({type}{reset}). Harness Team will not switch to an API key or any other paid method.',
  },
  'claude.quotaReset': { zh: '，约 {time} 重置', en: ', resets around {time}' },
  'claude.quotaWarning': { zh: 'Claude 订阅额度即将用尽（{type}{used}）', en: 'Claude subscription limit almost reached ({type}{used})' },
  'claude.quotaUsed': { zh: '，已用 {pct}%', en: ', {pct}% used' },
  'claude.overageUsing': {
    zh: '注意：该 Claude 账户正在使用 Extra Usage（超出订阅额度的按量用量），可能产生额外费用。',
    en: 'Note: this Claude account is using Extra Usage (pay-as-you-go beyond the subscription), which may cost extra.',
  },
  'claude.overageEnabled': {
    zh: '注意：该 Claude 账户已启用 Extra Usage；订阅额度用尽后，Claude Code 可能按量产生额外费用（这由你的 claude.ai 账户设置决定，Harness Team 无法关闭）。',
    en: 'Note: this Claude account has Extra Usage turned on; once the subscription limit is used up, Claude Code may incur pay-as-you-go charges (set in your claude.ai account; Harness Team cannot turn it off).',
  },
  'claude.denied': { zh: '本回合被拒绝的工具请求：{list}', en: 'Tool requests denied this turn: {list}' },

  // ---- tool activity titles ----
  'tool.sub': { zh: '（子代理）{title}', en: '(subagent) {title}' },
  'tool.edit': { zh: '修改文件：{path}', en: 'Edit file: {path}' },
  'tool.multiEdit': { zh: '修改文件：{path}（{n} 处）', en: 'Edit file: {path} ({n} edits)' },
  'tool.write': { zh: '写入文件：{path}', en: 'Write file: {path}' },
  'tool.notebook': { zh: '修改 Notebook：{path}', en: 'Edit notebook: {path}' },
  'tool.read': { zh: '读取：{path}', en: 'Read: {path}' },
  'tool.glob': { zh: '查找文件：{pattern}{where}', en: 'Find files: {pattern}{where}' },
  'tool.grep': { zh: '搜索内容：{pattern}{where}', en: 'Search: {pattern}{where}' },
  'tool.webSearch': { zh: '网络搜索：{query}', en: 'Web search: {query}' },
  'tool.webFetch': { zh: '获取网页：{url}', en: 'Fetch page: {url}' },
  'tool.plan': { zh: '计划（{done}/{total}）', en: 'Plan ({done}/{total})' },
  'tool.planPlain': { zh: '计划', en: 'Plan' },
  'tool.subagent': { zh: '子代理：{name}', en: 'Subagent: {name}' },
  'tool.skill': { zh: 'Skill：{name}', en: 'Skill: {name}' },
  'tool.other': { zh: '工具：{name}', en: 'Tool: {name}' },
  'tool.files': { zh: '修改 {n} 个文件：{list}', en: 'Changed {n} file(s): {list}' },
  'tool.filesPlain': { zh: '修改文件', en: 'Changed files' },
  'tool.subActivity': { zh: '子代理活动（{what}）', en: 'Subagent activity ({what})' },
  'tool.viewImage': { zh: '查看图片：{path}', en: 'View image: {path}' },
  'tool.compacted': { zh: '上下文已压缩', en: 'Context compacted' },
  'tool.reviewStarted': { zh: '开始代码审查：{what}', en: 'Code review started: {what}' },

  // ---- approval titles ----
  'approval.useTool': { zh: '请求使用 {tool}：{title}', en: 'Wants to use {tool}: {title}' },
  'approval.command': { zh: '请求执行命令：{command}', en: 'Wants to run a command: {command}' },
  'approval.files': { zh: '请求修改文件{list}', en: 'Wants to change files{list}' },
  'approval.filesList': { zh: '：{list}', en: ': {list}' },
  'approval.permissions': { zh: '请求额外权限', en: 'Wants additional permissions' },
  'approval.question': { zh: '需要用户回答问题', en: 'Needs your answer' },
  'approval.mcpInput': { zh: 'MCP「{server}」请求用户输入', en: 'MCP “{server}” asks for input' },
  'approval.patch': { zh: '请求应用补丁', en: 'Wants to apply a patch' },
  'approval.reason': { zh: '原因：{reason}', en: 'Reason: {reason}' },
  'approval.grantRoot': { zh: '申请对 {path} 的写权限', en: 'Asks for write access to {path}' },
} as const satisfies Record<string, { zh: string; en: string }>;

export type NoticeCode = keyof typeof T;

export function isNoticeCode(code: unknown): code is NoticeCode {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(T, code);
}

/** The label of a member's permission mode (null = follow the user's settings), in the runtime's own terms. */
export function permissionLabel(runtimeKind: string, mode: string | null): NoticeText {
  if (!mode) return { code: 'perm.follow' };
  const own = `perm.${runtimeKind}.${mode}`;
  return { code: isNoticeCode(own) ? own : (`perm.${mode}` as NoticeCode) };
}

/** Builds a NoticeText (drops null/undefined params so optional fragments just disappear). */
export function N(code: NoticeCode, params?: Record<string, NoticeValue | null | undefined>): NoticeText {
  if (!params) return { code };
  const clean: Record<string, NoticeValue> = {};
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) clean[k] = v;
  return Object.keys(clean).length ? { code, params: clean } : { code };
}

/** One-off text in both languages (same `{name}` placeholders and params as the coded templates). */
export function L(zh: string, en: string, params?: Record<string, NoticeValue | null | undefined>): NoticeText {
  if (!params) return { zh, en };
  const clean: Record<string, NoticeValue> = {};
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) clean[k] = v;
  return Object.keys(clean).length ? { zh, en, params: clean } : { zh, en };
}

/** A NoticeText this build can render (a known code, or inline text). */
export function isNotice(v: unknown): v is NoticeText {
  if (typeof v !== 'object' || v === null) return false;
  if ('code' in v) return isNoticeCode((v as { code: unknown }).code);
  return typeof (v as { zh?: unknown }).zh === 'string' && typeof (v as { en?: unknown }).en === 'string';
}

/** The notice's code, or null for inline text. */
export const noticeCode = (n: NoticeText | null | undefined): NoticeCode | null => (n && 'code' in n ? n.code : null);

function renderValue(v: NoticeValue | null | undefined, lang: NoticeLang): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (v.length && typeof v[0] === 'object') return (v as NoticeText[]).map((x) => renderNotice(x, lang)).join(lang === 'zh' ? '；' : '; ');
    return (v as string[]).join(lang === 'zh' ? '、' : ', ');
  }
  if ('lines' in v) return v.lines.map((x) => renderNotice(x, lang)).join('\n');
  return renderNotice(v, lang);
}

/** The text in one language. Unknown codes (from a newer server) render as nothing; callers fall back to the body. */
export function renderNotice(n: NoticeText, lang: NoticeLang): string {
  const tpl = 'code' in n ? (isNoticeCode(n.code) ? T[n.code][lang] : '') : typeof n[lang] === 'string' ? n[lang] : '';
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => renderValue(n.params?.[k], lang));
}

/** Chinese rendering: what the server stores as the message body. */
export const zhText = (n: NoticeText) => renderNotice(n, 'zh');

/**
 * Text that is either already plain (native output, user input, an older server's Chinese text) or translatable.
 * Used for runtime notes, catalog errors and turn errors that reach the UI outside a stored notice.
 */
export type Localized = string | NoticeText;

/** A Localized value in one language (plain strings as they are). */
export function localized(v: Localized | null | undefined, lang: NoticeLang): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : renderNotice(v, lang);
}

/** Chinese rendering of a Localized value (for storage, logs and agents). */
export const zhOf = (v: Localized | null | undefined): string => localized(v, 'zh');

/** An Error whose text exists in both languages; `message` is the Chinese one. */
export class NoticeError extends Error {
  readonly notice: NoticeText;
  constructor(notice: NoticeText) {
    super(zhText(notice));
    this.name = 'NoticeError';
    this.notice = notice;
  }
}

/** An Error for a Localized text (a NoticeError when it is translatable). */
export function localizedError(v: Localized): Error {
  return typeof v === 'string' ? new Error(v) : new NoticeError(v);
}

/** An error as a Localized value: its notice when it carries one, else its message. */
export function errorNotice(e: unknown): Localized {
  if (typeof e === 'object' && e !== null && 'notice' in e && isNotice((e as { notice: unknown }).notice)) return (e as { notice: NoticeText }).notice;
  return e instanceof Error ? e.message : String(e);
}

type Marker = [RegExp, (m: RegExpExecArray) => string];

/**
 * Fixed markers the server puts at the edges of details (stored as Chinese text, like message bodies). Each pattern is
 * anchored to the place the server writes it (start of the text, end of the text or the first line), so native content
 * in between (commands, paths, output) is never rewritten even when it contains the same words.
 */
const EDGE_MARKERS: Marker[] = [
  // Truncations (head/tail in the adapters, capActivityDetail in Core).
  [/^…（已截断，仅显示末尾 (\d+) 字符）\n/, (m) => `…(truncated, showing the last ${m[1]} characters)\n`],
  [/\n…（已截断：原文 (\d+) 字符，仅保存前 (\d+) 字符；完整内容见运行时自身的记录）$/, (m) => `\n…(truncated: ${m[1]} characters, only the first ${m[2]} kept; the runtime's own records have the full text)`],
  [/\n…（已截断）$/, () => '\n…(truncated)'],
];

/** Markers on the first line of tool-activity details (Codex command meta line, Claude Bash description, MCP error). */
const TOOL_MARKERS: Marker[] = [
  [/^错误：/, () => 'Error: '],
  [/^([^\n]*?)(^| · )耗时: (\d+) ms/, (m) => `${m[1]}${m[2]}Duration: ${m[3]} ms`],
  [/^([^\n]*?)(^| · )后台运行(?=\n|$)/, (m) => `${m[1]}${m[2]}Runs in the background`],
];

/** Markers in approval details: Codex's file-change grant line comes first. */
const APPROVAL_MARKERS: Marker[] = [[/^申请对 ([^\n]*) 的写权限(?=\n|$)/, (m) => `Asks for write access to ${m[1]}`]];

function applyMarkers(text: string, markers: Marker[]): string {
  let out = text;
  for (const [re, fn] of markers) out = out.replace(re, (...args) => fn(args.slice(0, -2) as unknown as RegExpExecArray));
  return out;
}

/** Approval detail text in the given language: only the markers the server adds; the request itself stays verbatim. */
export function localizeApprovalDetail(text: string, lang: NoticeLang): string {
  return lang === 'zh' ? text : applyMarkers(text, [...APPROVAL_MARKERS, ...EDGE_MARKERS]);
}

/** Tool-activity detail text in the given language (see EDGE_MARKERS). Native output itself is never changed. */
export function localizeDetail(text: string, lang: NoticeLang): string {
  if (lang === 'zh') return text;
  let out = applyMarkers(text, TOOL_MARKERS);
  out = applyMarkers(out, EDGE_MARKERS);
  return out;
}
