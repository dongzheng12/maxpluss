#!/usr/bin/env node
/**
 * pSEO sitemap 生成器
 *
 * 输入：data/seo-pages/manifest.jsonl（generate-seo-pages.js 产出）
 *       每行 {"code":"...","fname":"...","pub_date":"..."}
 *
 * 输出：
 *   data/seo-pages/sitemap-1.xml ... sitemap-N.xml （每个最多 50K URL）
 *   data/seo-pages/sitemap-index.xml
 *   data/seo-pages/robots.txt
 */
'use strict'
const fs = require('node:fs')
const readline = require('node:readline')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const MANIFEST = path.join(REPO_ROOT, 'data/seo-pages/manifest.jsonl')
const OUT_DIR = path.join(REPO_ROOT, 'data/seo-pages')
const SITE = 'https://biaozhunxiaozhi.com'
const URLS_PER_SHARD = 50000

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// 把 pub_date 规范成 YYYY-MM-DD（sitemap lastmod 推荐 W3C Datetime）
function normalizeDate(s) {
  if (!s) return ''
  const m = String(s).match(/^(\d{4})[-/]?(\d{2})?[-/]?(\d{2})?/)
  if (!m) return ''
  const y = m[1]
  const mo = m[2] || '01'
  const d = m[3] || '01'
  return `${y}-${mo}-${d}`
}

async function main() {
  if (!fs.existsSync(MANIFEST)) {
    console.error(`ERROR: manifest 不存在: ${MANIFEST}`)
    console.error('请先跑 node scripts/generate-seo-pages.js')
    process.exit(1)
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(MANIFEST),
    crlfDelay: Infinity,
  })

  let shardIndex = 1
  let urlsInShard = 0
  let totalUrls = 0
  let invalidLines = 0
  let shardFd = null

  function openShard() {
    const p = path.join(OUT_DIR, `sitemap-${shardIndex}.xml`)
    shardFd = fs.openSync(p, 'w')
    fs.writeSync(shardFd, '<?xml version="1.0" encoding="UTF-8"?>\n')
    fs.writeSync(shardFd, '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
    urlsInShard = 0
  }

  function closeShard() {
    if (shardFd === null) return
    fs.writeSync(shardFd, '</urlset>\n')
    fs.closeSync(shardFd)
    shardFd = null
  }

  openShard()

  for await (const line of rl) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { invalidLines++; continue }
    const fname = obj.fname
    if (!fname) { invalidLines++; continue }

    // loc 用 sanitized slug（与静态 HTML 文件名一致，nginx 直接命中）
    const loc = `${SITE}/standards/${fname}`
    const lastmod = normalizeDate(obj.pub_date)

    let entry = `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n`
    if (lastmod) entry += `    <lastmod>${lastmod}</lastmod>\n`
    entry += `    <changefreq>yearly</changefreq>\n`
    entry += `    <priority>0.6</priority>\n`
    entry += `  </url>\n`

    fs.writeSync(shardFd, entry)
    urlsInShard++
    totalUrls++

    if (urlsInShard >= URLS_PER_SHARD) {
      closeShard()
      shardIndex++
      openShard()
    }
  }

  closeShard()

  // 如果最后一个分片是空的（恰好整除），删除它
  const lastShardPath = path.join(OUT_DIR, `sitemap-${shardIndex}.xml`)
  if (urlsInShard === 0 && fs.existsSync(lastShardPath)) {
    fs.unlinkSync(lastShardPath)
    shardIndex--
  }

  // ── sitemap-index.xml ─────────────────────────────────────────────
  const idxPath = path.join(OUT_DIR, 'sitemap-index.xml')
  const idxFd = fs.openSync(idxPath, 'w')
  fs.writeSync(idxFd, '<?xml version="1.0" encoding="UTF-8"?>\n')
  fs.writeSync(idxFd, '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n')
  for (let i = 1; i <= shardIndex; i++) {
    fs.writeSync(idxFd, `  <sitemap>\n    <loc>${SITE}/sitemap-${i}.xml</loc>\n  </sitemap>\n`)
  }
  fs.writeSync(idxFd, '</sitemapindex>\n')
  fs.closeSync(idxFd)

  // ── robots.txt ────────────────────────────────────────────────────
  // 百度不处理"索引型 sitemap"，robots 里直接逐个列分片（非 sitemap-index）
  const sitemapLines = [
    `Sitemap: ${SITE}/sitemap-baidu-priority.txt`,
    `Sitemap: ${SITE}/sitemap-priority-v2.xml`,
  ]
  for (let i = 1; i <= shardIndex; i++) sitemapLines.push(`Sitemap: ${SITE}/sitemap-${i}.xml`)
  const robots = `User-agent: *
Allow: /standards/
Allow: /product/
Disallow: /api/
Disallow: /admin/
Disallow: /sales/
${sitemapLines.join('\n')}
`
  fs.writeFileSync(path.join(OUT_DIR, 'robots.txt'), robots)

  console.log(`=== 完成 ===`)
  console.log(`shards          = ${shardIndex}`)
  console.log(`total_urls      = ${totalUrls}`)
  console.log(`invalid_lines   = ${invalidLines}`)
  console.log(`urls_in_last    = ${urlsInShard}`)
  console.log(`sitemap-index   = ${idxPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
