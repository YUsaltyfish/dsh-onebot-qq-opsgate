/**
 * dsh-onebot-qq-opsgate — QQ 线（dsh-onebot-qq 的 qq-chat preset）的工具作用域门。
 *
 * 目标：preset 的 plugins 列表只能关掉它自己列出的工具插件；profile/bundle 层全局注册的工具
 * （dsh-ops 的 ops_*、agent-team、MCP 资源、working_directory…）依然会漏进 QQ 会话。
 * 本插件的唯一职责：在 **agent scope** 里调用 `ctx.tools.restrict({ deny })`，把这些全局工具
 * 从模型可见的工具目录里摘掉。
 *
 * 为什么必须挂在 preset 里（而不是 profile bundle 全局）：
 *   `tools.restrict()` 只接受 scoped context（agent.ctx），全局调用会直接报
 *   `requires a scoped context ... a context-global restriction would mask every agent`。
 *   本包自带的 cordis.patch.yml 只覆盖 `preset-qq-chat` 这一行（并在列表末尾追加本插件），
 *   因此只影响 QQ 会话，不碰网页/工作线/其他 preset。
 *
 * Linux / Windows 通用：纯 JS，不碰路径、不 spawn 进程。
 *
 * ⚠️ 全局工具是异步注册的：preset 先 apply，ops_* 等可能还没注册；`restrict` 对未注册的名字会
 *    抛 unknown global tools。lib/gate.js 会把「已注册的先挡住、未注册的每 500ms 重试」，
 *    最多等 90 秒（可配置）。这是本插件必须"可重试"的原因。
 */
import { DEFAULT_DENY, applyRestriction } from './lib/gate.js'

export const name = 'dsh-onebot-qq-opsgate'

/** 只依赖工具注册表；没有它 restrict 无处可挂（cordis 会等它出现再 apply）。 */
export const inject = ['tools']

/**
 * 刻意**不导出 Config schema**：本插件挂在 preset 的 plugins 列表里，配置由我们自己在 apply 里
 * 归一化（默认 deny 名单等）。这样不依赖 `@deepseek-ai/schemastery` 是否在 profile 里可解析，
 * 少一个跨平台/跨安装形态的翻车点；preset 行不写 config 时直接用默认名单。
 */
export function apply(ctx, config = {}) {
  const deny = Array.isArray(config?.deny) ? config.deny : DEFAULT_DENY
  const allow = Array.isArray(config?.allow) ? config.allow : []
  const retryMs = Number(config?.retryMs) > 0 ? Number(config.retryMs) : 500
  const maxMs = Number(config?.maxMs) > 0 ? Number(config.maxMs) : 90000

  const warn = (message) => {
    try { ctx.logger?.warn?.(`[dsh-onebot-qq-opsgate] ${message}`) } catch { console.warn(`[dsh-onebot-qq-opsgate] ${message}`) }
  }

  ctx.effect(
    () => applyRestriction(ctx, { deny, allow, retryMs, maxMs, log: { warn } }),
    'dsh-onebot-qq-opsgate: restrict global tools for QQ sessions',
  )
}
