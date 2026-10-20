#!/usr/bin/env node
/**
 * scripts/sync-preset.mjs — 从 dsh-onebot-qq 的 cordis.patch.yml 重新生成本包的 preset 覆盖。
 *
 * 为什么需要：本包通过「覆盖 preset-qq-chat 这一行 + 在 plugins 末尾追加自身」来工作，
 * 所以本包里的 preset 插件列表必须和 dsh-onebot-qq 当前版本的 qq-chat 保持一致。
 * dsh-onebot-qq 升级后跑一次：
 *
 *   npm run sync:preset -- --bot ../dsh-onebot-qq/cordis.patch.yml
 *
 * 生成结果会保留开头注释与末尾的 gate 行。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const botPatch = path.resolve(ROOT, arg('--bot', '../dsh-onebot-qq/cordis.patch.yml'))
const outFile = path.resolve(ROOT, arg('--out', 'cordis.patch.yml'))

const text = fs.readFileSync(botPatch, 'utf8')
const lines = text.split('\n')
const start = lines.findIndex((line) => /^ {4}- id: preset-qq-chat\s*$/.test(line))
if (start < 0) throw new Error(`在 ${botPatch} 里没找到 "    - id: preset-qq-chat"`)

const preset = lines
  .slice(start)
  .map((line) => (line.startsWith('    ') ? line.slice(4) : line))

// 去掉尾部空行，准备在 plugins 列表末尾追加 gate 行
while (preset.length && preset[preset.length - 1].trim() === '') preset.pop()

const gateRow = [
  '',
  '      # ── 本包：工具作用域门（preset 内加载；挡住全局插件注册的工具）──',
  "      - id: dsh-onebot-qq-opsgate",
  "        name: 'dsh-onebot-qq-opsgate'",
  '',
]

const header = [
  '# dsh-onebot-qq-opsgate bundle patch',
  '#',
  '# 作用：只覆盖 dsh-onebot-qq 的 `preset-qq-chat` 这一行，在它的 plugins 列表末尾追加本插件。',
  '#   · 本插件在 agent scope 内调用 ctx.tools.restrict({ deny }) → 把全局插件注册的工具（ops_*、',
  '#     agent-team、MCP 资源等）从 QQ 会话的工具目录里摘掉；',
  '#   · 只影响 qq-chat 会话，不碰网页/工作线/其他 preset；',
  '#   · 必须在 profile bundles 里排在 dsh-onebot-qq 之后（后层覆盖前层）。',
  '#',
  '# ⚠️ 本文件的 preset 内容由 scripts/sync-preset.mjs 从 dsh-onebot-qq 的 cordis.patch.yml 生成；',
  '#    dsh-onebot-qq 升级后重新生成，别手改下面这段。',
  '',
]

fs.writeFileSync(outFile, `${[...header, ...preset, ...gateRow].join('\n').trimEnd()}\n`)
console.log(`已生成 ${path.relative(ROOT, outFile)}（来源：${botPatch}）`)
