#!/usr/bin/env node
/**
 * pSEO 静态 HTML 生成器
 *
 * 输入：data/crawled_v2/all_standards.json (~275MB, 487K 条, minified 单行 JSON)
 * 输出：data/seo-pages/standards/<sanitized-code>.html
 *
 * 重要约束：
 *  - 仅展示元数据，绝对不含 fulltext（版权合规，已清空）
 *  - 流式解析，brace-counting state machine，零依赖
 *  - 文件名 sanitize：'/' 空格 其他特殊字符 → '-'，全小写，多 '-' 合并，trim
 *  - canonical / og:url 用 encodeURIComponent(原始 code)，跟 SPA 路由对齐
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const INPUT = path.join(REPO_ROOT, 'data/crawled_v2/all_standards.json')
const OUT_DIR = path.join(REPO_ROOT, 'data/seo-pages/standards')
const MANIFEST = path.join(REPO_ROOT, 'data/seo-pages/manifest.jsonl')
const SITE = 'https://biaozhunxiaozhi.com'

// CLI: --limit=N 只处理前 N 条（debug），默认 0=全量
const LIMIT = (() => {
  const a = process.argv.find(x => x.startsWith('--limit='))
  return a ? parseInt(a.split('=')[1], 10) : 0
})()

// ── 工具 ────────────────────────────────────────────────────────────
function sanitize(code) {
  return code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // 任何非 a-z0-9 都换成 -
    .replace(/^-+|-+$/g, '')     // trim 首尾 -
}

function escapeHtml(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeAttr(s) { return escapeHtml(s) }

// JSON.stringify 自动处理 JSON-LD 的字符串转义
function buildJsonLd(s, cleanUrl) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: s.name || s.code,
    identifier: s.code,
    url: cleanUrl,
  }
  if (s.pub_date) ld.datePublished = s.pub_date
  if (s.name_en) ld.alternateName = s.name_en
  const pubName = s.publisher || s.issuing_dept || s.tc_committee
  if (pubName) ld.publisher = { '@type': 'Organization', name: pubName }
  if (s.ics_name || s.ccs_name) {
    ld.about = [s.ics_name, s.ccs_name].filter(Boolean).join('；')
  }
  return JSON.stringify(ld)
}

function buildHtml(s, fname) {
  const code = s.code
  const name = s.name || ''
  const status = s.status || ''
  const pubDate = s.pub_date || ''
  const implDate = s.impl_date || ''
  const icsCode = s.ics_code || ''
  const icsName = s.ics_name || ''
  const ccs = s.ccs || ''
  const ccsName = s.ccs_name || ''
  const tc = s.tc_committee || ''
  const drafting = s.drafting_org || ''
  const issuing = s.issuing_dept || ''
  const replaces = s.replaces || ''
  const nameEn = s.name_en || ''

  // canonical / og:url 用 sanitized slug（与文件名一致），让搜索引擎和静态 nginx 命中同一 URL
  const canonical = `${SITE}/standards/${fname}`
  // SPA 详情页（"查看完整信息"）保持原始 code 的 URI 编码格式
  const spaPath = `/standards/${encodeURIComponent(code)}`

  const title = `${code} ${name} - 标准小智`
  const desc = [
    name,
    `标准号 ${code}`,
    status && `状态：${status}`,
    pubDate && `发布日期：${pubDate}`,
  ].filter(Boolean).join('，')

  const keywords = [code, name, icsName, ccsName, '标准查询']
    .filter(Boolean)
    .join(', ')

  const jsonLd = buildJsonLd(s, canonical)

  // 可见内容：定义列表
  const rows = []
  rows.push(['标准号', code])
  if (name) rows.push(['标准名称', name])
  if (nameEn) rows.push(['英文名称', nameEn])
  if (status) rows.push(['状态', status])
  if (pubDate) rows.push(['发布日期', pubDate])
  if (implDate) rows.push(['实施日期', implDate])
  if (icsCode || icsName) rows.push(['ICS 分类', [icsCode, icsName].filter(Boolean).join(' ')])
  if (ccs || ccsName) rows.push(['CCS 分类', [ccs, ccsName].filter(Boolean).join(' ')])
  if (tc) rows.push(['归口单位', tc])
  if (drafting) rows.push(['起草单位', drafting])
  if (issuing) rows.push(['发布部门', issuing])
  if (replaces) rows.push(['替代关系', replaces])

  const rowsHtml = rows
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
    .join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeAttr(desc)}">
<meta name="keywords" content="${escapeAttr(keywords)}">
<meta name="generator" content="标准小智 pSEO">
<link rel="canonical" href="${escapeAttr(canonical)}">
<meta property="og:title" content="${escapeAttr(title)}">
<meta property="og:description" content="${escapeAttr(desc)}">
<meta property="og:url" content="${escapeAttr(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="标准小智">
<script type="application/ld+json">${jsonLd}</script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#222;line-height:1.6}
h1{font-size:22px;margin:0 0 4px;color:#0052d9}
.code{color:#888;font-size:14px;margin-bottom:24px}
dl{display:grid;grid-template-columns:120px 1fr;gap:8px 16px;margin:16px 0;font-size:14px}
dt{color:#666}
dd{margin:0;color:#222;word-break:break-word}
.cta{margin-top:32px;padding:16px;background:#f0f5ff;border-radius:8px;text-align:center}
.cta a{color:#0052d9;text-decoration:none;font-weight:600}
.foot{margin-top:48px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#999;text-align:center}
</style>
<meta name="baidu-site-verification" content="codeva-CuoMihYoFG" />
<!-- 百度统计 -->
<script>
var _hmt = _hmt || [];
(function(){var hm=document.createElement("script");hm.src="https://hm.baidu.com/hm.js?d9051828e0a1934884786a52323d32f6";var s=document.getElementsByTagName("script")[0];s.parentNode.insertBefore(hm,s);})();
</script>
</head>
<body>
<h1>${escapeHtml(name || code)}</h1>
<div class="code">${escapeHtml(code)}</div>
<dl>${rowsHtml}</dl>
<div class="cta"><a href="${spaPath}">查看完整信息 →</a></div>
<div class="foot">本页仅展示标准元数据，不含全文。© 标准小智</div>
</body>
</html>
`
}

// ── 流式 brace-counting parser ────────────────────────────────────
async function main() {
  const stream = fs.createReadStream(INPUT, { highWaterMark: 1 << 20 }) // 1MB chunks
  const decoder = new (require('node:string_decoder').StringDecoder)('utf8')

  let buf = ''
  let i = 0  // 持久化跨 consume 调用，保证状态机正确性
  let started = false  // 是否已找到 standards 数组的 [
  let depth = 0
  let inString = false
  let escapeNext = false
  let objStart = -1

  const seenNames = new Set() // sanitized 文件名去重
  let total = 0
  let written = 0
  let skippedNoCode = 0
  let collisions = 0
  const collisionLog = []

  const manifestFd = fs.openSync(MANIFEST, 'w')

  const t0 = Date.now()

  function processObject(objStr) {
    total++
    let obj
    try {
      obj = JSON.parse(objStr)
    } catch (e) {
      console.error(`[skip] JSON parse error at #${total}:`, e.message, objStr.slice(0, 100))
      return
    }
    const code = obj.code
    if (!code || !String(code).trim()) {
      skippedNoCode++
      return
    }
    const fname = sanitize(code)
    if (!fname) {
      skippedNoCode++
      return
    }
    if (seenNames.has(fname)) {
      collisions++
      if (collisionLog.length < 20) collisionLog.push({ code, fname })
      return
    }
    seenNames.add(fname)

    const html = buildHtml(obj, fname)
    fs.writeFileSync(path.join(OUT_DIR, fname + '.html'), html)
    fs.writeSync(manifestFd, JSON.stringify({ code, fname, pub_date: obj.pub_date || '' }) + '\n')
    written++

    if (written % 10000 === 0) {
      const sec = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`[progress] written=${written}  total_seen=${total}  skipped_no_code=${skippedNoCode}  collisions=${collisions}  elapsed=${sec}s`)
    }
    if (LIMIT > 0 && written >= LIMIT) throw new Error('__LIMIT_REACHED__')
  }

  function consume(chunk) {
    buf += chunk

    while (i < buf.length) {
      const c = buf[i]

      if (!started) {
        if (c === '[') { started = true }
        i++
        continue
      }

      if (escapeNext) { escapeNext = false; i++; continue }
      if (inString) {
        if (c === '\\') escapeNext = true
        else if (c === '"') inString = false
        i++
        continue
      }
      if (c === '"') { inString = true; i++; continue }

      if (c === '{') {
        if (depth === 0) objStart = i
        depth++
        i++
        continue
      }
      if (c === '}') {
        depth--
        if (depth === 0 && objStart !== -1) {
          const objStr = buf.slice(objStart, i + 1)
          processObject(objStr)
          objStart = -1
        }
        i++
        continue
      }
      i++
    }

    // 切 buf 防无限增长：i, objStart 同步调整
    if (depth === 0 && objStart === -1) {
      buf = buf.slice(i)
      i = 0
    } else if (objStart > 0) {
      buf = buf.slice(objStart)
      i -= objStart
      objStart = 0
    }
  }

  try {
    for await (const chunk of stream) {
      consume(decoder.write(chunk))
    }
    consume(decoder.end())
  } catch (e) {
    if (e.message !== '__LIMIT_REACHED__') throw e
    console.log(`[limit] reached ${LIMIT}, stopping`)
  }

  fs.closeSync(manifestFd)

  const sec = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\n=== 完成 ===`)
  console.log(`total_seen      = ${total}`)
  console.log(`written         = ${written}`)
  console.log(`skipped_no_code = ${skippedNoCode}`)
  console.log(`collisions      = ${collisions}`)
  console.log(`elapsed         = ${sec}s`)
  if (collisionLog.length) {
    console.log(`\n[collision sample (前 ${collisionLog.length} 条)]`)
    for (const c of collisionLog) console.log(`  ${c.code} → ${c.fname}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
