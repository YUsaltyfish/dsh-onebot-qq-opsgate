/**
 * dsh-onebot-qq-opsgate — QQ 线（dsh-onebot-qq 的 qq-chat preset）的工具作用域门。
 *
 * 职责：在 **agent scope** 里调用 `ctx.tools.restrict()`，把 profile/bundle 层**全局注册**的
 * 工具（`ops_*`、agent-team、MCP 资源、goal/job/schedule…）从 QQ 会话的工具目录里摘掉。
 *
 * 默认 **auto 模式**：不维护"要挡谁"的名单——探测 DSH 当前所有全局工具，只放行
 * `allowedPrefixes`（默认 `mcp__qq__*`）与 `keep` 里的精确名字，其余全部 deny。
 * 这样以后新增任何全局插件/工具都自动挡住，不会因为名单漏了某个 `ops_*` 而漏工具。
 * 显式传 `deny` / `allow` 数组则退回旧的固定名单模式。
 *
 * 为什么必须挂在 preset 里（而不是 profile bundle 全局）：
 *   `tools.restrict()` 只接受 scoped context（agent.ctx），全局调用会直接报
 *   `requires a scoped context ... a context-global restriction would mask every agent`。
 *   本包自带的 cordis.patch.yml 只覆盖 `preset-qq-chat` 这一行（并在列表末尾追加本插件），
 *   因此只影响 QQ 会话，不碰网页/工作线/其他 preset。
 *
 * Linux / Windows 通用：纯 JS，不碰路径、不 spawn 进程。
 */
import { applyRestriction } from './lib/gate.js'

export const name = 'dsh-onebot-qq-opsgate'

/** 只依赖工具注册表；没有它 restrict 无处可挂（cordis 会等它出现再 apply）。 */
export const inject = ['tools']

/**
 * 刻意**不导出 Config schema**：本插件挂在 preset 的 plugins 列表里，配置由我们自己在 apply 里
 * 归一化，这样不依赖 `@deepseek-ai/schemastery` 是否在 profile 里可解析。
 */
export function apply(ctx, config = {}) {
  const warn = (message) => {
    try { ctx.logger?.warn?.(`[dsh-onebot-qq-opsgate] ${message}`) } catch { console.warn(`[dsh-onebot-qq-opsgate] ${message}`) }
  }

  const options = {
    retryMs: Number(config?.retryMs) > 0 ? Number(config.retryMs) : 500,
    maxMs: Number(config?.maxMs) > 0 ? Number(config.maxMs) : 30000,
    settleRounds: Number(config?.settleRounds) > 0 ? Number(config.settleRounds) : 8,
    log: { warn },
  }
  // auto 模式的放行规则（显式传 deny/allow 时按旧模式走，下面两个字段不生效）
  if (Array.isArray(config?.allowedPrefixes)) options.allowedPrefixes = config.allowedPrefixes
  if (Array.isArray(config?.keep)) options.keep = config.keep
  // 兼容旧配置：显式名单 → 固定模式
  if (Array.isArray(config?.deny)) options.deny = config.deny
  if (Array.isArray(config?.allow)) options.allow = config.allow

  ctx.effect(
    () => applyRestriction(ctx, options),
    'dsh-onebot-qq-opsgate: restrict global tools for QQ sessions',
  )
}
