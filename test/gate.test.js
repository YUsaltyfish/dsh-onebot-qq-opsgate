import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyRestriction, parseUnknownTools, parseKnownGlobalTools, DEFAULT_DENY,
} from '../lib/gate.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PROBE = '__dsh_opsgate_probe__'

/**
 * 假 ctx：模拟 DSH tools.restrict 的行为——
 *   · 名字不在 known 里 → 抛错，错误里带 "known global tools: ..."（探测就靠这个）；
 *   · 名字都在 known 里 → 记下 filter，返回撤销函数。
 */
function fakeCtx(knownTools) {
  const known = new Set(knownTools)
  const calls = []
  const disposed = []
  const warnings = []
  const ctx = {
    logger: { warn: (message) => warnings.push(String(message)) },
    tools: {
      restrict(filter) {
        calls.push(filter)
        const names = [...(filter.allow ?? []), ...(filter.deny ?? [])]
        const unknown = names.filter((name) => !known.has(name))
        if (unknown.length) {
          throw new Error(
            `tools.restrict() names unknown global tool${unknown.length > 1 ? 's' : ''} `
            + `${unknown.map((n) => `"${n}"`).join(', ')}; known global tools: ${[...known].sort().join(', ') || '(none)'}`,
          )
        }
        const disposer = () => disposed.push(filter)
        return disposer
      },
    },
  }
  return { ctx, calls, disposed, warnings, known }
}

// 普通 QQ 线该保留的全局工具 + 一堆不该有的全局工具
const GLOBAL_BASE = [
  'mcp__qq__send_message', 'mcp__qq__send_image', 'mcp__qq__generate_image',
  'mcp__qq__recall', 'mcp__qq__avatar', 'mcp__qq__send_sticker',
  'mcp__qq__sticker_catalog', 'mcp__qq__read_memory',
  'ops_glob', 'ops_grep', 'ops_bash', 'ops_write_file', 'ops_edit_file',
  'ops_diff', 'ops_stat', 'ops_copy', 'ops_move', 'ops_remove',
  'spawn_teammate', 'list_agents', 'send_message',
  'create_goal', 'update_goal', 'todo_write', 'job_list', 'present',
]

test('auto 模式：探测全局工具后只放行 mcp__qq__*，其余全部 deny', async () => {
  const { ctx, calls, disposed } = fakeCtx(GLOBAL_BASE)
  const dispose = applyRestriction(ctx, { retryMs: 5, maxMs: 200, settleRounds: 2 })
  await sleep(60)

  const denyCalls = calls.filter((c) => Array.isArray(c.deny) && !c.deny.includes(PROBE))
  assert.ok(denyCalls.length >= 1, '应发出实际的 deny 限制')

  const denied = new Set(denyCalls.flatMap((c) => c.deny))
  for (const name of GLOBAL_BASE) {
    if (name.startsWith('mcp__qq__')) assert.equal(denied.has(name), false, `放行名单被误挡：${name}`)
    else assert.equal(denied.has(name), true, `应被挡但漏了：${name}`)
  }
  assert.equal(denyCalls.some((c) => c.deny.includes(PROBE)), false, '探测调用不能变成实际限制')

  dispose()
  assert.ok(disposed.length >= 1, '卸载时应撤销 restrict')
})

test('auto 模式：启动后才注册的全局工具会补挡（deny 是并集）', async () => {
  const { ctx, calls, known } = fakeCtx(['mcp__qq__send_message', 'ops_glob'])
  applyRestriction(ctx, { retryMs: 10, maxMs: 400, settleRounds: 30 })
  await sleep(35)
  known.add('ops_bash')
  known.add('spawn_teammate')
  await sleep(120)

  const denied = new Set(calls.filter((c) => Array.isArray(c.deny) && !c.deny.includes(PROBE)).flatMap((c) => c.deny))
  assert.equal(denied.has('ops_glob'), true)
  assert.equal(denied.has('ops_bash'), true, '后注册的 ops_bash 也要补挡')
  assert.equal(denied.has('spawn_teammate'), true)
  assert.equal(denied.has('mcp__qq__send_message'), false, 'QQ 原生工具不能被挡')
})

test('固定名单模式（显式 deny）：逐项重试，QQ 工具不受影响', async () => {
  const { ctx, calls } = fakeCtx(['ops_glob'])
  applyRestriction(ctx, { deny: ['ops_glob'], retryMs: 5, maxMs: 100 })
  await sleep(20)
  assert.deepEqual(calls[0], { deny: ['ops_glob'] })
})

test('探测失败（报错里没有 known 清单）→ 退回固定 DEFAULT_DENY，仍能挡主机工具', async () => {
  const calls = []
  const warnings = []
  const ctx = {
    logger: { warn: (m) => warnings.push(String(m)) },
    tools: {
      restrict(filter) {
        calls.push(filter)
        throw new Error('some unexpected restrict failure')
      },
    },
  }
  applyRestriction(ctx, { retryMs: 5, maxMs: 60, settleRounds: 1 })
  await sleep(40)

  assert.ok(calls.some((c) => Array.isArray(c.deny) && c.deny.includes('ops_write_file')), '应带兜底名单')
  assert.ok(calls.some((c) => Array.isArray(c.deny) && c.deny.length === DEFAULT_DENY.length), '兜底名单应完整')
  assert.ok(warnings.some((w) => w.includes('探测失败')), '应提示探测失败')
})

test('没有全局工具：不产生实际限制，也不报错', async () => {
  const { ctx, calls } = fakeCtx([])
  applyRestriction(ctx, { retryMs: 5, maxMs: 40, settleRounds: 1 })
  await sleep(30)
  assert.equal(calls.filter((c) => Array.isArray(c.deny) && !c.deny.includes(PROBE)).length, 0)
})

test('工具名解析：unknown / known 两种报错格式', () => {
  assert.deepEqual(
    parseUnknownTools('tools.restrict() names unknown global tools "a", "b"; known global tools: c, d'),
    ['a', 'b'],
  )
  assert.deepEqual(
    parseKnownGlobalTools('tools.restrict() names unknown global tool "__x"; known global tools: a, b, c'),
    ['a', 'b', 'c'],
  )
  assert.equal(parseKnownGlobalTools('(none)'), null)
  assert.deepEqual(parseKnownGlobalTools('known global tools: (none)'), [])
})
