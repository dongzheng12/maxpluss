#!/usr/bin/env node
/**
 * 把 src/data/sensitive-words/*.txt 编译成 words.gen.ts
 * 重新拉取词库时跑一次：node scripts/gen-sensitive-words.mjs
 *
 * 拆分原因：esbuild --loader:.txt=text 与 vitest/vite 的 ?raw 不兼容，
 * 用生成 TS 模块的方式让两端走同一份输入，无需特殊 loader。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dataDir = resolve(__dirname, '../src/data/sensitive-words')

function parse(filename) {
  const raw = readFileSync(resolve(dataDir, filename), 'utf8')
  const words = raw
    .split(/[,，\r\n]+/)
    .map(w => w.trim())
    .filter(w => w.length >= 2 && w.length <= 30)
  return Array.from(new Set(words))
}

const political = parse('政治类.txt')
const sexual = parse('色情类.txt')
const weapons = parse('涉枪涉爆.txt')

const out = `/**
 * 自动生成 — 由 scripts/gen-sensitive-words.mjs 从 src/data/sensitive-words/*.txt 编译
 * 来源：fwwdn/sensitive-stop-words (Apache 2.0)
 * 拉取时间：2026-04-26
 *
 * 不要手工编辑本文件。要更新：改 txt 或 NOTICE.md → 重跑 gen 脚本。
 */

export const POLITICAL_WORDS: readonly string[] = ${JSON.stringify(political, null, 2)}

export const SEXUAL_WORDS: readonly string[] = ${JSON.stringify(sexual, null, 2)}

export const WEAPONS_WORDS: readonly string[] = ${JSON.stringify(weapons, null, 2)}

export const COUNTS = {
  political: ${political.length},
  sexual: ${sexual.length},
  weapons: ${weapons.length},
  total: ${political.length + sexual.length + weapons.length},
} as const
`

writeFileSync(resolve(dataDir, 'words.gen.ts'), out, 'utf8')
console.log(`✅ words.gen.ts: 政治 ${political.length} / 色情 ${sexual.length} / 涉枪涉爆 ${weapons.length} → 共 ${political.length + sexual.length + weapons.length}`)
