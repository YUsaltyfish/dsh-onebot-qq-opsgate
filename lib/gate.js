/**
 * lib/gate.js — 在 agent scope 里挡全局工具。
 *
 * 两种模式：
 *   ① **auto（默认）**：不再维护"要挡谁"的名单，而是反着来——
 *      先探测 DSH 当前注册了哪些**全局工具**，只放行 `allowedPrefixes`（默认 `mcp__qq__*`）
 *      与 `keep` 里的精确名字，其余全部 deny。这样以后新增任何全局插件/工具都自动挡住，
 *      不会出现"名单漏了 ops_write_file 就漏工具"的问题。
 *   ② **fixed（兼容旧配置）**：显式传 `deny` / `allow` 数组时，按老逻辑逐项重试。
 *
 * 两层防线：`restrict()` 只能摘掉**全局层**注册的工具；`ops_bash` / agent-team 等由
 * agent scope 注册的工具还在目录里，必须再用 `ctx.tools.guard()` 在执行前拒绝。
 * 目录里仍可能显示这些名字（费一点 token），但真正调用会被拦下。
 *
 * 探测方式：`ctx.tools.restrict({ deny: ['__dsh_opsgate_probe__'] })` 必然报错，错误里带
 * "known global tools: a, b, c"，从中解析出当前全局工具清单（探测调用不会产生实际限制）。
 *
 * 为什么只 deny 新增名字而不是 allow 交集：DSH 的 restrict 层是**交集**的，allow 每加一层
 * 都会进一步收窄（后注册的工具就永远放不回来）；deny 层则是并集，后续发现新的多余工具
 * 可以不断追加，安全得多。
 *
 * 卸载时撤销所有 restrict 层。
 */

/** auto 模式默认放行的工具名前缀（QQ 线自己的原生工具）。 */
export const DEFAULT_ALLOWED_PREFIXES = ['mcp__qq__']

/** auto 模式额外精确放行的工具（如果它们恰好是全局工具）。 */
export const DEFAULT_KEEP = ['web_search', 'web_fetch']

/** 默认固定名单（仅 fixed 模式 / 探测失败兜底使用）。 */
export const DEFAULT_DENY = [
  // dsh-ops（profile 全局）：主机文件 / shell
  'ops_glob', 'ops_grep', 'ops_inspect_local_file', 'ops_replace',
  'ops_write_file', 'ops_edit_file', 'ops_diff', 'ops_stat',
  'ops_copy', 'ops_move', 'ops_remove', 'ops_bash',
  // agent-team（profile 全局）：子代理 / 团队任务
  'spawn_teammate', 'list_agents', 'interrupt_agent', 'wait_agent', 'send_message',
  'team_task_create', 'team_task_get', 'team_task_list', 'team_task_update',
  'subagent', 'subagent_fork', 'list_subagent_models',
  // MCP 资源（全局）
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  // 主机侧 / 调度 / 目标 / 交互类全局工具
  'working_directory',
  'create_goal', 'get_goal', 'update_goal',
  'todo_write', 'ask_user_question', 'present', 'read_image',
  'job_list', 'job_output', 'job_kill',
  'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
]

/** 探测用的假工具名：必然不在全局工具表里。 */
const PROBE_NAME = '__dsh_opsgate_probe__'

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

/** 从报错里解析「当前已知的全局工具」清单；解析不出返回 null。 */
export function parseKnownGlobalTools(message) {
  const text = String(message ?? '')
  const at = text.search(/known global tools:\s*/i)
  if (at < 0) return null
  const raw = text.slice(at).replace(/^known global tools:\s*/i, '').trim()
  if (!raw || raw === '(none)') return []
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** 探测当前全局工具名（失败/无此接口 → null）。探测本身不会留下任何限制。 */
export function probeKnownGlobalTools(ctx) {
  try {
    const disposer = ctx.tools.restrict({ deny: [PROBE_NAME] })
    // 理论上不会成功（PROBE_NAME 不存在）；真成功了也立刻撤销，不影响任何工具。
    if (typeof disposer === 'function') disposer()
    return null
  } catch (error) {
    return parseKnownGlobalTools(error?.message ?? error)
  }
}

/** 判断是不是「根本没有 scoped context / 空过滤」这类重试也不会好的错误。 */
function isFatalConfigurationError(message) {
  return /requires a scoped context|context-global restriction|is a no-op/i.test(String(message ?? ''))
}

const makeWarn = (ctx, log) => {
  if (typeof log?.warn === 'function') return log.warn
  return (message) => {
    try { ctx.logger?.warn?.(String(message)) } catch { console.warn(String(message)) }
  }
}

const makeInfo = (ctx, log) => {
  if (typeof log?.info === 'function') return log.info
  return (message) => {
    try { ctx.logger?.info?.(String(message)) } catch { /* ignore */ }
  }
}

/**
 * 安装 agent scope 执行前守卫。
 *
 * `tools.restrict()` 只作用于全局层，管不到 agent scope 自己注册的工具
 * （如 `ops_bash` / `spawn_teammate`）：这些名字仍会出现在工具目录里，但执行时
 * 由 `tools.guard()` 统一返回拒绝原因。`isAllowed(name)` 为 true 才放行。
 *
 * @returns {Function|null} 卸载函数；接口不可用或注册失败时返回 null（只告警，不影响 restrict）。
 */
function installGuard(ctx, isAllowed, warn) {
  try {
    if (typeof ctx.tools?.guard !== 'function') {
      warn('ctx.tools.guard 不可用：scoped 注册的工具无法在执行前拦截')
      return null
    }
    return ctx.tools.guard((exec) => {
      const name = String(exec?.name || '')
      if (!name || isAllowed(name)) return undefined
      return `QQ 线不提供 ${name}（dsh-onebot-qq-opsgate 工具门）`
    })
  } catch (error) {
    warn(`tools.guard 注册失败（scoped 工具将无法拦截）: ${error?.message ?? error}`)
    return null
  }
}

/**
 * 自动模式：探测全局工具 → 除放行名单外全部 deny；启动后若干轮内持续补挡新出现的工具。
 * 永不抛错，最差只是少挡几个。
 */
function applyAuto(ctx, options) {
  const {
    retryMs = 500, maxMs = 30000, settleRounds = 8,
    allowedPrefixes = DEFAULT_ALLOWED_PREFIXES, keep = DEFAULT_KEEP,
    log = {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = Date.now,
  } = options
  const warn = makeWarn(ctx, log)

  const prefixes = (Array.isArray(allowedPrefixes) ? allowedPrefixes : []).map(String).filter(Boolean)
  const keepSet = new Set((Array.isArray(keep) ? keep : []).map(String).filter(Boolean))
  const isAllowed = (name) => prefixes.some((p) => name.startsWith(p)) || keepSet.has(name)
  // 先装执行前守卫：restrict() 只摘全局层，scoped 工具要靠 guard 兜底。
  const guardDispose = installGuard(ctx, isAllowed, warn)

  const disposers = []
  const denied = new Set()
  const timers = new Set()
  const startedAt = now()
  let done = false
  let quiet = 0
  let probeFailed = false

  const cleanup = () => {
    for (const timer of timers) clearTimeoutFn(timer)
    timers.clear()
  }
  const finish = () => { done = true; cleanup() }

  const attempt = () => {
    if (done) return

    const known = probeKnownGlobalTools(ctx)
    if (known === null) {
      // 探测接口不按预期报错：退回固定名单，至少挡掉已知的主机工具。
      probeFailed = true
      finish()
      warn('全局工具探测失败（restrict 行为与预期不符），退回固定 deny 名单')
      applyFixed(ctx, { deny: DEFAULT_DENY, retryMs, maxMs, log, setTimeoutFn, clearTimeoutFn, now })
      return
    }

    const fresh = known.filter((name) => !isAllowed(name) && !denied.has(name))
    if (fresh.length) {
      try {
        const disposer = ctx.tools.restrict({ deny: fresh })
        if (typeof disposer === 'function') disposers.push(disposer)
        for (const name of fresh) denied.add(name)
        quiet = 0
      } catch (error) {
        const message = String(error?.message ?? error ?? '')
        if (isFatalConfigurationError(message)) {
          finish()
          warn(`工具屏蔽未生效（本插件必须加载在 agent preset 里，例如 qq-chat 的 plugins 列表；全局加载无效）: ${message}`)
          return
        }
        // 名称在探测与 restrict 之间消失了之类的竞态：下一轮再试。
      }
    } else {
      quiet += 1
    }

    // 连续 settleRounds 轮没有新工具，且已挡过东西 → 认为启动期注册已稳定。
    if ((quiet >= settleRounds && denied.size > 0) || now() - startedAt >= maxMs) {
      finish()
      if (!denied.size) warn('没有发现需要屏蔽的全局工具（可能尚未注册完成）')
      else {
        const info = makeInfo(ctx, log)
        info(`已屏蔽 ${denied.size} 个全局工具（仅放行 ${prefixes.join(', ') || '(无前缀)'}${keepSet.size ? ' + ' + [...keepSet].join(', ') : ''}）`)
      }
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
    if (typeof guardDispose === 'function') {
      try { guardDispose() } catch { /* 卸载阶段忽略 */ }
    }
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 卸载阶段忽略 */ }
    }
    void probeFailed
  }
}

/** 固定名单模式（旧行为 / 探测失败兜底）：逐项重试，未知名字先跳过。 */
function applyFixed(ctx, options) {
  const {
    deny = [], allow = [], retryMs = 500, maxMs = 90000,
    log = {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = Date.now,
  } = options
  const warn = makeWarn(ctx, log)

  const tasks = []
  const denyNames = [...new Set((Array.isArray(deny) ? deny : []).map(String))].filter(Boolean)
  const allowNames = [...new Set((Array.isArray(allow) ? allow : []).map(String))].filter(Boolean)
  if (denyNames.length) tasks.push({ filter: 'deny', names: denyNames })
  if (allowNames.length) tasks.push({ filter: 'allow', names: allowNames })
  if (!tasks.length) return () => {}

  // 固定名单同样要执行前守卫：deny 模式只拒绝名单内，allow 模式只放行名单内。
  const denySet = new Set(denyNames)
  const allowSet = new Set(allowNames)
  const guardDispose = installGuard(
    ctx,
    (name) => (allowSet.size ? allowSet.has(name) : !denySet.has(name)),
    warn,
  )

  const disposers = []
  const timers = new Set()
  const applied = new Map(tasks.map((t) => [t.filter, new Set()]))
  const startedAt = now()
  let done = false

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
    } catch {
      return false
    }
  }

  const attempt = () => {
    if (done) return
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
    if (typeof guardDispose === 'function') {
      try { guardDispose() } catch { /* 卸载阶段忽略 */ }
    }
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* 卸载阶段忽略 */ }
    }
  }
}

/**
 * 对外入口：显式传 `deny` / `allow` 数组 → 固定名单模式；否则自动探测模式。
 * 返回 disposer（卸载时撤销所有 restrict）。
 */
export function applyRestriction(ctx, options = {}) {
  const explicit = Array.isArray(options.deny) || Array.isArray(options.allow)
  if (explicit) {
    return applyFixed(ctx, {
      ...options,
      deny: Array.isArray(options.deny) ? options.deny : [],
      allow: Array.isArray(options.allow) ? options.allow : [],
    })
  }
  return applyAuto(ctx, options)
}
