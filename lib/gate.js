/**
 * lib/gate.js — 纯逻辑：在 agent scope 里挡全局工具（可重试 / 可卸载，不依赖 DSH 运行时，便于单测）。
 *
 * 对外只暴露 applyRestriction(ctx, options)：
 *   options = { deny?, allow?, retryMs?, maxMs?, log?, setTimeoutFn?, clearTimeoutFn?, now? }
 *   返回 disposer（卸载时撤销所有 restrict）。
 *
 * ctx 只需要两样东西：`ctx.tools.restrict(filter)`（返回 disposer）和 `ctx.logger?.warn`（可选）。
 */

/** 默认要挡的全局工具：QQ 线（纯聊天 preset）不该有的主机侧 / 团队侧 / 调度类工具。 */
export const DEFAULT_DENY = [
  // dsh-ops（profile 全局）：主机文件 / shell
  'ops_glob',
  'ops_grep',
  'ops_inspect_local_file',
  'ops_replace',
  'ops_bash',
  // agent-team（profile 全局）：子代理 / 团队任务
  'spawn_teammate',
  'list_agents',
  'interrupt_agent',
  'wait_agent',
  'send_message',
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
  // MCP 资源（全局）：QQ 线用 mcp__qq__read_memory，不直接读资源
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  // 主机侧 cwd 工具（全局）
  'working_directory',
]

/** 从 restrict 的报错里抠出「未知工具」的名字（切掉后面的 known 清单）。解析不出返回 []。 */
export function parseUnknownTools(message) {
  const text = String(message ?? '')
  const at = text.search(/unknown global tools?/i)
  if (at < 0) return []
  const tail = text.slice(at)
  const knownAt = tail.search(/known global tools:/i)
  const region = knownAt >= 0 ? tail.slice(0, knownAt) : tail
  return [...region.matchAll(/"([^"]+)"/g)].map((m) => m[1])
}

/** 判断是不是「根本没有 scoped context / 空过滤」这类重试也不会好的错误。 */
function isFatalConfigurationError(message) {
  return /requires a scoped context|context-global restriction|is a no-op/i.test(String(message ?? ''))
}

/**
 * 把 deny/allow 名单挂到当前 agent scope；立即尝试一次，未注册的工具名按 retryMs 重试，
 * 超过 maxMs 放弃（日志列出没挡上的）。永不抛错，最差只是少挡几个。
 */
export function applyRestriction(ctx, options = {}) {
  const {
    deny = DEFAULT_DENY,
    allow = [],
    retryMs = 500,
    maxMs = 90000,
    log = {},
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    now = Date.now,
  } = options

  const warn = typeof log.warn === 'function'
    ? log.warn
    : (message) => {
        try { ctx.logger?.warn?.(String(message)) } catch { console.warn(String(message)) }
      }

  const tasks = []
  const denyNames = [...new Set((Array.isArray(deny) ? deny : []).map(String))].filter(Boolean)
  const allowNames = [...new Set((Array.isArray(allow) ? allow : []).map(String))].filter(Boolean)
  if (denyNames.length) tasks.push({ filter: 'deny', names: denyNames })
  if (allowNames.length) tasks.push({ filter: 'allow', names: allowNames })
  if (!tasks.length) return () => {}

  const disposers = []
  const timers = new Set()
  const applied = new Map(tasks.map((t) => [t.filter, new Set()]))
  const startedAt = now()
  let done = false
  let attempts = 0

  const pendingOf = (task) => task.names.filter((n) => !applied.get(task.filter).has(n))
  const hasPending = () => tasks.some((t) => pendingOf(t).length > 0)

  const cleanup = () => {
    for (const timer of timers) clearTimeoutFn(timer)
    timers.clear()
  }

  const markApplied = (task, names) => {
    for (const name of names) applied.get(task.filter).add(name)
  }

  const tryRestrict = (filterObject, task, names) => {
    try {
      const disposer = ctx.tools.restrict(filterObject)
      if (typeof disposer === 'function') disposers.push(disposer)
      markApplied(task, names)
      return true
    } catch (error) {
      return { error }
    }
  }

  const attempt = () => {
    if (done) return
    attempts += 1

    const pending = tasks.filter((t) => pendingOf(t).length > 0)
    if (!pending.length) { done = true; cleanup(); return }

    const filterObject = {}
    for (const task of pending) filterObject[task.filter] = pendingOf(task)

    try {
      const disposer = ctx.tools.restrict(filterObject)
      if (typeof disposer === 'function') disposers.push(disposer)
      for (const task of pending) markApplied(task, pendingOf(task))
      done = true
      cleanup()
      return
    } catch (error) {
      const message = String(error?.message ?? error ?? '')
      const unknown = parseUnknownTools(message)

      if (unknown.length) {
        // 先把「已经注册了的」挡住，剩下的下一轮再试
        for (const task of pending) {
          const usable = pendingOf(task).filter((name) => !unknown.includes(name))
          if (usable.length) tryRestrict({ [task.filter]: usable }, task, usable)
        }
      } else if (isFatalConfigurationError(message)) {
        done = true
        cleanup()
        warn(`工具屏蔽未生效（本插件必须加载在 agent preset 里，例如 qq-chat 的 plugins 列表；全局加载无效）: ${message}`)
        return
      }
      // 其余情况（还没注册完 / 未知报错）：继续重试
    }

    if (hasPending() === false) { done = true; cleanup(); return }
    if (now() - startedAt >= maxMs) {
      done = true
      cleanup()
      const missing = tasks.flatMap((task) => pendingOf(task).map((name) => `${task.filter}:${name}`))
      warn(`仍有工具没挡上（可能一直没注册）: ${missing.join(', ')}`)
      return
    }

    const timer = setTimeoutFn(attempt, retryMs)
    timer?.unref?.()
    timers.add(timer)
  }

  attempt()

  return () => {
    done = true
    cleanup()
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 卸载阶段忽略 */ }
    }
  }
}
