/**
 * heap-probe — timeout 保护压测
 *
 * 目的：模拟 pyapi 挂起场景，验证：
 *   1. 我们加的 timeout 真的触发 AbortController（不会无限 hang）
 *   2. 连续 N 次调用后 heap 不持续增长（Promise 不堆积泄漏）
 *
 * 运行方式：
 *   cd services/api
 *   SVC_LLM_PRIMARY_KEY= SVC_LLM_FALLBACK_KEY= NODE_OPTIONS=--expose-gc \
 *     npx tsx scripts/heap-probe.ts
 *
 * 脚本自己起一个 hang 的 pyapi 替身（永不响应），触发所有 fetch timeout。
 */

import http from 'http'

// 本地起 hang server，所有请求永远不 response，用来触发 fetch timeout
const hangPort = 28765
const hangServer = http.createServer((_req, _res) => {
  // never respond
})
await new Promise<void>((resolve) => hangServer.listen(hangPort, resolve))
process.env.PYAPI_BASE_URL = `http://127.0.0.1:${hangPort}`

const { buildZeroResultSuggestions } = await import('../src/services/chatSearch.js')
const { fetchReferenceStandards } = await import('../src/services/chatStdWriting.js')

function mem(): { heapMB: number; rssMB: number } {
  const m = process.memoryUsage()
  return {
    heapMB: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
    rssMB: Math.round((m.rss / 1024 / 1024) * 10) / 10,
  }
}

const N = 5
console.log(`== heap probe (N=${N}) ==`)
console.log(`PYAPI_BASE_URL=${process.env.PYAPI_BASE_URL || '(default)'}`)
console.log(`LLM keys set: primary=${!!process.env.SVC_LLM_PRIMARY_KEY} fallback=${!!process.env.SVC_LLM_FALLBACK_KEY}`)
console.log(`gc available: ${typeof (globalThis as any).gc === 'function'}`)
const gc = (globalThis as any).gc as (() => void) | undefined
if (gc) gc()
console.log(`start: ${JSON.stringify(mem())}`)

const heapSnapshots: number[] = []
for (let i = 1; i <= N; i++) {
  const t0 = Date.now()
  const results = await Promise.allSettled([
    buildZeroResultSuggestions(`不存在的超冷词${i}xyzabc`, [`冷词${i}`], new Set(), 1),
    fetchReferenceStandards(`帮我起草${i}一个不存在主题的产品标准`),
  ])
  const elapsed = Date.now() - t0
  if (gc) gc()
  const m = mem()
  heapSnapshots.push(m.heapMB)
  const statuses = results.map(r => r.status).join(',')
  console.log(`iter ${i}/${N}  t=${elapsed}ms  heap=${m.heapMB}MB  rss=${m.rssMB}MB  [${statuses}]`)
}

console.log(`end:   ${JSON.stringify(mem())}`)

// 判定：第一轮 vs 最后一轮 heap diff < 20MB 视为稳定
const first = heapSnapshots[0]
const last = heapSnapshots[heapSnapshots.length - 1]
const delta = last - first
const max = Math.max(...heapSnapshots)
const min = Math.min(...heapSnapshots)
console.log(`\n=== 判定 ===`)
console.log(`first=${first}MB  last=${last}MB  delta=${delta > 0 ? '+' : ''}${delta}MB  peak=${max}MB  min=${min}MB`)
hangServer.close()
if (delta > 20) {
  console.log(`❌ FAIL：heap 增长 > 20MB，疑似泄漏`)
  process.exit(1)
} else {
  console.log(`✅ PASS：heap 稳定（delta ≤ 20MB）`)
  process.exit(0)
}
