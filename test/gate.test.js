import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyRestriction, parseUnknownTools, DEFAULT_DENY } from '../lib/gate.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 假 ctx：记录 restrict 调用与 disposer 调用。 */
function fakeCtx(restrictImpl) {
  const calls = []
  const disposed = []
  const warnings = []
  return {
    calls,
    disposed,
    warnings,
    ctx: {
      logger: { warn: (message) => warnings.push(String(message)) },
      tools: {
        restrict(filter) {
          calls.push(filter)
          const disposer = restrictImpl(filter)
          return () => disposed.push(disposer)
        },
      },
    },
  }
}

test('默认名单：挡掉全局工具并返回可撤销的 disposer', () => {
  const { ctx, calls, disposed } = fakeCtx(() => {})
  const dispose = applyRestriction(ctx, { deny: ['ops_glob', 'team_task_list'] })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { deny: ['ops_glob', 'team_task_list'] })
  dispose()
  assert.equal(disposed.length, 1, '卸载时应撤销 restrict')
})

test('异步注册：先挡已注册的，未知的 500ms 重试（这里用 5ms）', async () => {
  const registered = new Set(['ops_glob'])
  const { ctx, calls } = fakeCtx((filter) => {
    const names = filter.deny ?? filter.allow ?? []
    const unknown = names.filter((name) => !registered.has(name))
    if (unknown.length) {
      throw new Error(
        `tools.restrict() names unknown global tools ${unknown.map((n) => `"${n}"`).join(', ')}; known global tools: ${[...registered].join(', ')}`,
      )
    }
  })

  applyRestriction(ctx, { deny: ['ops_glob', 'team_task_list'], retryMs: 5, maxMs: 200 })
  assert.equal(calls[0].deny.length, 2, '第一次带全名单')
  await sleep(2)
  registered.add('team_task_list')
  await sleep(40)

  assert.ok(calls.some((c) => c.deny && c.deny.length === 1 && c.deny[0] === 'ops_glob'), '先挡已注册的')
  assert.ok(calls.some((c) => c.deny && c.deny.length === 1 && c.deny[0] === 'team_task_list'), '注册后补挡')
})

test('全局加载（没有 agent scope）：只警告一次，不抛错、不无限重试', async () => {
  const { ctx, calls, warnings } = fakeCtx(() => {
    throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent')
  })

  applyRestriction(ctx, { deny: ['ops_glob'], retryMs: 5, maxMs: 100 })
  await sleep(40)

  assert.equal(calls.length, 1, '重试无意义，只试一次')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /preset|全局加载无效/)
})

test('空名单：不碰工具注册表', () => {
  const { ctx, calls } = fakeCtx(() => {})
  applyRestriction(ctx, { deny: [], allow: [] })
  assert.equal(calls.length, 0)
})

test('一直注册不上：到 maxMs 放弃并日志列出缺的名字', async () => {
  const { ctx, warnings } = fakeCtx(() => {
    throw new Error('tools.restrict() names unknown global tool "never_registered"; known global tools: ops_glob')
  })

  applyRestriction(ctx, { deny: ['never_registered'], retryMs: 5, maxMs: 25 })
  await sleep(80)

  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /never_registered/)
})

test('parseUnknownTools：能从报错里抠出未注册工具名', () => {
  assert.deepEqual(
    parseUnknownTools('tools.restrict() names unknown global tools "a", "b"; known global tools: "c", "d"'),
    ['a', 'b'],
  )
  assert.deepEqual(parseUnknownTools('some other error'), [])
  assert.ok(DEFAULT_DENY.includes('ops_bash'))
})
