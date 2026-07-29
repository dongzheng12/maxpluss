#!/usr/bin/env node
/**
 * SEO priority URL selector.
 *
 * 用途：
 *   1) 为百度主动推送选择少量高商业价值 URL
 *   2) 生成给搜索引擎单独提交的小而精 sitemap-priority.xml
 *   3) 生成外链投放清单
 *
 * 输入：data/seo-pages/manifest.jsonl
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'data/seo-pages/manifest.jsonl')
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'data/seo-pages')
const DEFAULT_SITE = 'https://biaozhunxiaozhi.com'

function parseArgs(argv) {
  const args = {
    manifest: DEFAULT_MANIFEST,
    outDir: DEFAULT_OUT_DIR,
    site: DEFAULT_SITE,
    limit: 5000,
    format: 'generate',
    pushedFile: '',
  }
  for (const arg of argv) {
    if (arg.startsWith('--manifest=')) args.manifest = arg.slice('--manifest='.length)
    else if (arg.startsWith('--out-dir=')) args.outDir = arg.slice('--out-dir='.length)
    else if (arg.startsWith('--site=')) args.site = arg.slice('--site='.length).replace(/\/+$/, '')
    else if (arg.startsWith('--limit=')) args.limit = Number(arg.slice('--limit='.length))
    else if (arg.startsWith('--format=')) args.format = arg.slice('--format='.length)
    else if (arg.startsWith('--exclude-pushed=')) args.pushedFile = arg.slice('--exclude-pushed='.length)
    else if (arg === '-h' || arg === '--help') {
      console.log(`Usage:
  node scripts/seo-priority.js --format=generate --limit=5000
  node scripts/seo-priority.js --format=urls --limit=8 --exclude-pushed=data/seo-pages/.baidu-pushed-urls.txt

Formats:
  generate  write priority-urls.txt, sitemap-priority.xml, external-link-pack.md
  urls      print selected URLs only
  sitemap   print sitemap XML to stdout
  links     print markdown link pack to stdout`)
      process.exit(0)
    } else {
      console.error(`ERROR: unknown arg: ${arg}`)
      process.exit(64)
    }
  }
  if (!Number.isInteger(args.limit) || args.limit < 1) {
    console.error(`ERROR: --limit must be a positive integer, got: ${args.limit}`)
    process.exit(64)
  }
  if (!['generate', 'urls', 'sitemap', 'links'].includes(args.format)) {
    console.error(`ERROR: --format must be generate, urls, sitemap, or links. got: ${args.format}`)
    process.exit(64)
  }
  return args
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function extractYear(code, pubDate) {
  const fromPubDate = String(pubDate || '').match(/\b(20\d{2}|19\d{2})\b/)
  if (fromPubDate) return Number(fromPubDate[1])
  const fromCode = String(code || '').match(/[-\s](20\d{2}|19\d{2})(?:\D|$)/)
  return fromCode ? Number(fromCode[1]) : 0
}

function normalizeDate(s) {
  if (!s) return ''
  const m = String(s).match(/^(\d{4})[-/]?(\d{2})?[-/]?(\d{2})?/)
  if (!m) return ''
  const y = m[1]
  const mo = m[2] || '01'
  const d = m[3] || '01'
  return `${y}-${mo}-${d}`
}

function extractNumber(code) {
  const m = String(code || '').toUpperCase().match(/\b(?:GB|GB\/T|AQ|HG|JB|YY|HJ|DL|NB|SN|RB|DB)\s*([0-9]+)/)
  return m ? Number(m[1]) : 999999
}

function scoreStandard(row) {
  const code = String(row.code || '').trim().toUpperCase()
  const year = extractYear(code, row.pub_date)
  const num = extractNumber(code)
  let score = 0

  if (/^GB\s*[0-9]/.test(code)) score += 1000000
  else if (/^GB\/T\s*[0-9]/.test(code)) score += 760000
  else if (/^(AQ|YY|HJ|SN)\s*[0-9]/.test(code)) score += 430000
  else if (/^(HG|JB|DL|NB|RB|DB)\s*[0-9]/.test(code)) score += 300000

  if (year) score += year * 100
  if (num < 100) score += 70000
  else if (num < 1000) score += 45000
  else if (num < 10000) score += 18000

  // 通用、基础和强检类标准更可能有搜索需求，也更接近转化入口。
  if (/^(GB|GB\/T)\s*(1|2|3|4|5|6|7|8|9|10)(\.|[-\s]|$)/.test(code)) score += 90000
  if (/^(GB|GB\/T)\s*(175|811|190|191|2760|2893|3095|3836|4806|5009|7718|14881|16886|18401|18583|28001|45001)(\.|[-\s]|$)/.test(code)) score += 120000
  if (/食品|安全|质量|检验|检测|管理|通用|基础|水泥|头盔|包装|环境|职业健康/.test(code)) score += 25000

  return score
}

function readPushed(file) {
  if (!file || !fs.existsSync(file)) return new Set()
  return new Set(fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean))
}

function readRows(args) {
  if (!fs.existsSync(args.manifest)) {
    console.error(`ERROR: manifest not found: ${args.manifest}`)
    process.exit(1)
  }
  const pushed = readPushed(args.pushedFile)
  const rows = []
  for (const line of fs.readFileSync(args.manifest, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    if (!obj.fname) continue
    const url = `${args.site}/standards/${obj.fname}`
    if (pushed.has(url)) continue
    rows.push({
      code: obj.code || '',
      fname: obj.fname,
      pub_date: obj.pub_date || '',
      url,
      score: scoreStandard(obj),
    })
  }
  rows.sort((a, b) => b.score - a.score || String(a.code).localeCompare(String(b.code), 'zh-CN') || a.url.localeCompare(b.url))
  return rows.slice(0, args.limit)
}

function titleFor(row, outDir) {
  const htmlPath = path.join(outDir, 'standards', `${row.fname}.html`)
  if (!fs.existsSync(htmlPath)) return row.code
  const html = fs.readFileSync(htmlPath, 'utf8')
  const h1 = html.match(/<h1>(.*?)<\/h1>/)
  if (!h1) return row.code
  return h1[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function renderSitemap(rows) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
  for (const row of rows) {
    const lastmod = normalizeDate(row.pub_date)
    lines.push('  <url>')
    lines.push(`    <loc>${xmlEscape(row.url)}</loc>`)
    if (lastmod) lines.push(`    <lastmod>${lastmod}</lastmod>`)
    lines.push('  </url>')
  }
  lines.push('</urlset>')
  return `${lines.join('\n')}\n`
}

function renderLinks(rows, outDir) {
  const top = rows.slice(0, Math.min(rows.length, 80))
  const lines = [
    '# 标准小智外链投放清单',
    '',
    '用途：知乎回答、公众号文章、合作站资源页、目录页。优先使用前 20 条，锚文本保持自然，不要批量堆同一文案。',
    '',
    '## 推荐锚文本',
    '',
  ]
  for (const row of top) {
    const title = titleFor(row, outDir)
    lines.push(`- [${row.code} ${title}](${row.url})`)
  }
  lines.push('')
  lines.push('## 组合文案')
  lines.push('')
  lines.push('- 标准查询入口：国家标准号、发布日期、实施日期、ICS/CCS 分类等元数据查询。')
  lines.push('- 示例链接：可围绕食品安全、建筑材料、职业健康、安全生产、标准化导则等主题自然引用。')
  return `${lines.join('\n')}\n`
}

function renderEntryPage(rows, outDir, site) {
  const top = rows.slice(0, Math.min(rows.length, 200))
  const links = top.map((row) => {
    const title = titleFor(row, outDir)
    return `        <li><a href="${xmlEscape(row.url)}">${xmlEscape(row.code)} ${xmlEscape(title)}</a></li>`
  }).join('\n')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>热门国家标准查询入口 - 标准小智</title>
  <meta name="description" content="标准小智热门国家标准查询入口，聚合高频国家标准、食品安全、环境安全、质量管理和职业健康等标准元数据页面。">
  <link rel="canonical" href="${xmlEscape(site)}/standards-priority.html">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;max-width:920px;margin:0 auto;padding:32px 18px;color:#222;line-height:1.65}
    h1{font-size:28px;margin:0 0 10px;color:#123}
    p{color:#555;margin:0 0 20px}
    ol{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:8px 28px;padding-left:22px}
    li{break-inside:avoid}
    a{color:#0052d9;text-decoration:none}
    a:hover{text-decoration:underline}
    .meta{font-size:13px;color:#777;border-top:1px solid #eee;margin-top:30px;padding-top:14px}
  </style>
</head>
<body>
  <main>
    <h1>热门国家标准查询入口</h1>
    <p>以下为标准小智优先整理的高频标准元数据页面，覆盖国家标准、食品安全、环境安全、质量管理、职业健康和标准化基础规则等方向。</p>
    <ol>
${links}
    </ol>
    <p class="meta">本页仅提供标准元数据入口，不提供标准全文。更多标准可访问 <a href="${xmlEscape(site)}/standards">标准信息查询</a>。</p>
  </main>
</body>
</html>
`
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const rows = readRows(args)

  if (args.format === 'urls') {
    process.stdout.write(rows.map(r => r.url).join('\n') + (rows.length ? '\n' : ''))
    return
  }
  if (args.format === 'sitemap') {
    process.stdout.write(renderSitemap(rows))
    return
  }
  if (args.format === 'links') {
    process.stdout.write(renderLinks(rows, args.outDir))
    return
  }

  fs.mkdirSync(args.outDir, { recursive: true })
  const entryUrl = `${args.site}/standards-priority.html`
  fs.writeFileSync(path.join(args.outDir, 'priority-urls.txt'), [entryUrl, ...rows.map(r => r.url)].join('\n') + '\n')
  fs.writeFileSync(path.join(args.outDir, 'sitemap-baidu-priority.txt'), [entryUrl, ...rows.map(r => r.url)].join('\n') + '\n')
  const prioritySitemap = renderSitemap(rows)
  fs.writeFileSync(path.join(args.outDir, 'sitemap-priority-v2.xml'), prioritySitemap)
  // Keep the legacy filename non-404 for previously submitted tools, but robots uses v2.
  fs.writeFileSync(path.join(args.outDir, 'sitemap-priority.xml'), prioritySitemap)
  fs.writeFileSync(path.join(args.outDir, 'external-link-pack.md'), renderLinks(rows, args.outDir))
  fs.writeFileSync(path.join(args.outDir, 'standards-priority.html'), renderEntryPage(rows, args.outDir, args.site))

  console.log(`priority_urls = ${rows.length}`)
  console.log(`sitemap       = ${path.join(args.outDir, 'sitemap-priority-v2.xml')}`)
  console.log(`baidu_txt     = ${path.join(args.outDir, 'sitemap-baidu-priority.txt')}`)
  console.log(`url_list      = ${path.join(args.outDir, 'priority-urls.txt')}`)
  console.log(`link_pack     = ${path.join(args.outDir, 'external-link-pack.md')}`)
  console.log(`entry_page    = ${path.join(args.outDir, 'standards-priority.html')}`)
}

if (require.main === module) {
  main()
}

module.exports = {
  normalizeDate,
  renderEntryPage,
  renderSitemap,
  xmlEscape,
}
