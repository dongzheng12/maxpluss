#!/usr/bin/env node
/**
 * Enrich priority pSEO pages with metadata-only, copyright-safe content.
 *
 * Scope:
 *   - Rewrites only URLs listed in data/seo-pages/priority-urls.txt
 *   - Uses metadata from data/crawled_v2/all_standards.json
 *   - Does not read or generate standard body/fulltext
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const REPO_ROOT = path.resolve(__dirname, '..')
const INPUT = path.join(REPO_ROOT, 'data/crawled_v2/all_standards.json')
const PRIORITY_URLS = path.join(REPO_ROOT, 'data/seo-pages/priority-urls.txt')
const OUT_DIR = path.join(REPO_ROOT, 'data/seo-pages/standards')
const SITE = 'https://biaozhunxiaozhi.com'

const LIMIT = (() => {
  const arg = process.argv.find(x => x.startsWith('--limit='))
  return arg ? Number(arg.slice('--limit='.length)) : 0
})()

function sanitize(code) {
  return String(code || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
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

function compact(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function splitList(s, max = 8) {
  return String(s || '')
    .split(/[;；,，、]/)
    .map(x => compact(x))
    .filter(Boolean)
    .slice(0, max)
}

function yearOf(row) {
  const source = `${row.pub_date || ''} ${row.impl_date || ''} ${row.code || ''}`
  const m = source.match(/\b(20\d{2}|19\d{2})\b/)
  return m ? Number(m[1]) : 0
}

function codePrefix(code) {
  const s = String(code || '').toUpperCase()
  const m = s.match(/^(GB\/T|GB|AQ|YY|HJ|HG|JB|DL|NB|SN|RB|DB)/)
  return m ? m[1] : ''
}

function codeNumber(code) {
  const s = String(code || '').toUpperCase()
  const m = s.match(/\b(?:GB\/T|GB|AQ|YY|HJ|HG|JB|DL|NB|SN|RB|DB)\s*([0-9]+)/)
  return m ? Number(m[1]) : 0
}

function buildJsonLd(row, canonical) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'CreativeWork',
    name: row.name || row.code,
    identifier: row.code,
    url: canonical,
  }
  if (row.pub_date) ld.datePublished = row.pub_date
  if (row.name_en) ld.alternateName = row.name_en
  const publisher = row.publisher || row.issuing_dept || row.tc_committee
  if (publisher) ld.publisher = { '@type': 'Organization', name: publisher }
  if (row.ics_name || row.ccs_name) ld.about = [row.ics_name, row.ccs_name].filter(Boolean).join('；')
  return JSON.stringify(ld)
}

function normalizeRows(rows) {
  const bySlug = new Map()
  const byCode = new Map()
  const byIcs = new Map()
  const byCcs = new Map()
  const byTc = new Map()
  const byPrefix = new Map()

  for (const row of rows) {
    const slug = sanitize(row.code)
    if (!slug || bySlug.has(slug)) continue
    row.__slug = slug
    row.__year = yearOf(row)
    row.__num = codeNumber(row.code)
    bySlug.set(slug, row)
    byCode.set(String(row.code || '').toUpperCase(), row)

    for (const [map, key] of [
      [byIcs, row.ics_code],
      [byCcs, row.ccs],
      [byTc, row.tc_committee],
      [byPrefix, codePrefix(row.code)],
    ]) {
      const k = compact(key)
      if (!k) continue
      if (!map.has(k)) map.set(k, [])
      map.get(k).push(row)
    }
  }

  for (const map of [byIcs, byCcs, byTc, byPrefix]) {
    for (const list of map.values()) {
      list.sort((a, b) => (b.__year - a.__year) || String(a.code).localeCompare(String(b.code), 'zh-CN'))
    }
  }
  return { bySlug, byCode, byIcs, byCcs, byTc, byPrefix }
}

function relatedFrom(map, key, self, limit) {
  if (!key || !map.has(key)) return []
  return map.get(key).filter(row => row.__slug !== self.__slug).slice(0, limit)
}

function relatedByNumber(map, key, self, limit) {
  if (!key || !map.has(key)) return []
  const selfNum = self.__num || 0
  return map.get(key)
    .filter(row => row.__slug !== self.__slug)
    .map(row => ({
      row,
      distance: selfNum && row.__num ? Math.abs(row.__num - selfNum) : 999999,
    }))
    .sort((a, b) => a.distance - b.distance || (b.row.__year - a.row.__year) || String(a.row.code).localeCompare(String(b.row.code), 'zh-CN'))
    .slice(0, limit)
    .map(x => x.row)
}

function linkFor(row) {
  return `${SITE}/standards/${row.__slug}`
}

function relatedList(title, rows) {
  if (!rows.length) return ''
  const lis = rows
    .map(row => `<li><a href="${escapeAttr(linkFor(row))}">${escapeHtml(row.code)} ${escapeHtml(row.name || '')}</a></li>`)
    .join('')
  return `<section>
<h2>${escapeHtml(title)}</h2>
<p>以下标准与本页标准存在分类、领域或组织维度上的关联，可用于进一步比较标准状态、发布日期、实施日期和分类信息。</p>
<ul>${lis}</ul>
</section>`
}

function replacementBlock(row, byCode) {
  const items = splitList(row.replaces, 12)
  if (!items.length) return ''
  const lis = items.map(item => {
    const linked = byCode.get(item.toUpperCase())
    if (linked) return `<li><a href="${escapeAttr(linkFor(linked))}">${escapeHtml(item)} ${escapeHtml(linked.name || '')}</a></li>`
    return `<li>${escapeHtml(item)}</li>`
  }).join('')
  return `<section>
<h2>替代关系与历史版本</h2>
<p>${escapeHtml(row.code)} 标注了替代关系，查询时建议同步关注被替代版本、实施日期和当前状态，避免在引用、采购、检测或合规文件中使用过期标准号。</p>
<ul>${lis}</ul>
</section>`
}

function metadataTable(row) {
  const rows = [
    ['标准号', row.code],
    ['标准名称', row.name],
    ['英文名称', row.name_en],
    ['状态', row.status],
    ['发布日期', row.pub_date],
    ['实施日期', row.impl_date],
    ['ICS 分类', [row.ics_code, row.ics_name].filter(Boolean).join(' ')],
    ['CCS 分类', [row.ccs, row.ccs_name].filter(Boolean).join(' ')],
    ['归口单位', row.tc_committee],
    ['起草单位', splitList(row.drafting_org, 10).join('；')],
    ['发布部门', row.issuing_dept],
    ['采用国际标准', row.adopted_intl],
    ['替代关系', row.replaces],
  ].filter(([, v]) => compact(v))

  return `<dl>${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>`
}

function overview(row) {
  const category = [row.ics_code && `${row.ics_code} ${row.ics_name || ''}`, row.ccs && `${row.ccs} ${row.ccs_name || ''}`].filter(Boolean).join('；') || '暂未标注完整分类'
  const dates = [row.pub_date && `发布日期为 ${row.pub_date}`, row.impl_date && `实施日期为 ${row.impl_date}`].filter(Boolean).join('，') || '发布日期和实施日期请以后续官方更新为准'
  const publisher = row.issuing_dept || row.publisher || '相关主管部门'
  return `<section>
<h2>标准概览</h2>
<p>${escapeHtml(row.code)}《${escapeHtml(row.name || row.code)}》是标准小智收录的标准元数据页面，当前状态为${escapeHtml(row.status || '待确认')}，${escapeHtml(dates)}。本页聚合标准号、名称、状态、分类、发布部门、归口单位、起草单位和替代关系等检索信息，便于在立项、采购、检测、认证、合规检查和标准执行任务中快速确认基础信息。</p>
<p>该标准的分类信息为：${escapeHtml(category)}。分类字段可帮助用户从同一专业领域继续查找相关标准，也能辅助判断标准之间的上下游关系。发布部门记录为${escapeHtml(publisher)}，如页面展示了归口单位或起草单位，可继续结合组织维度追踪同领域标准。</p>
</section>`
}

function organizationBlock(row) {
  const orgs = splitList(row.drafting_org, 8)
  const tc = compact(row.tc_committee)
  const issuing = compact(row.issuing_dept || row.publisher)
  if (!orgs.length && !tc && !issuing) return ''
  const orgText = orgs.length ? `起草单位包括 ${orgs.map(escapeHtml).join('、')}。` : ''
  const tcText = tc ? `归口单位为 ${escapeHtml(tc)}。` : ''
  const issueText = issuing ? `发布部门为 ${escapeHtml(issuing)}。` : ''
  return `<section>
<h2>组织与发布信息</h2>
<p>${issueText}${tcText}${orgText}这些组织信息适合用于判断标准的管理归属、专业领域和后续修订线索。对于企业内部标准执行、供应商审核、检测委托或制度文件引用，建议同时核对发布部门、归口单位和当前状态。</p>
</section>`
}

function usageBlock(row) {
  const name = row.name || row.code
  return `<section>
<h2>查询与使用建议</h2>
<p>查询 ${escapeHtml(row.code)} ${escapeHtml(name)} 时，建议优先确认四类信息：第一，标准状态是否仍为现行；第二，实施日期是否已经生效；第三，是否存在替代或被替代关系；第四，ICS/CCS 分类是否与当前业务场景一致。标准小智当前仅展示元数据，不提供标准全文，适合作为标准检索、版本核对和站内跳转入口。</p>
<p>如果该标准用于合同、招投标、检测报告、产品说明、培训资料或企业制度文件，建议在正式引用前再次核对官方发布渠道和组织内部适用要求。对于同一分类下的标准，可通过本页相关标准链接继续查看相近标准号，避免只根据名称判断适用范围。</p>
</section>`
}

function scenarioBlock(row) {
  const code = escapeHtml(row.code)
  const name = escapeHtml(row.name || row.code)
  const ics = escapeHtml([row.ics_code, row.ics_name].filter(Boolean).join(' ') || '未标注 ICS 分类')
  const ccs = escapeHtml([row.ccs, row.ccs_name].filter(Boolean).join(' ') || '未标注 CCS 分类')
  const tc = escapeHtml(row.tc_committee || row.issuing_dept || '相关管理组织')
  const year = yearOf(row)
  const yearText = year ? `该标准元数据中可识别的年份线索为 ${year} 年，` : ''
  return `<section>
<h2>适用场景与检索线索</h2>
<p>${code} ${name} 的页面信息适合在标准号核验、版本追踪、同类标准扩展检索和内部合规资料整理时使用。${yearText}用户可结合发布日期、实施日期和状态字段判断当前引用是否需要更新；若页面存在替代关系，应优先查看新旧版本之间的标准号变化，再决定是否继续沿用原引用。</p>
<p>从分类角度看，本页记录的 ICS 线索为 ${ics}，CCS 线索为 ${ccs}，组织线索为 ${tc}。这些字段不会替代标准正文，但能帮助用户缩小检索范围：例如先按 ICS/CCS 找到同领域标准，再按发布部门、归口单位或标准号前缀判断它们是否属于同一标准体系。</p>
</section>`
}

function numberBlock(row) {
  const prefix = codePrefix(row.code) || '标准'
  const num = row.__num || '未识别'
  const year = yearOf(row) || '未识别'
  const forceText = prefix === 'GB'
    ? 'GB 前缀通常表示国家标准；在企业合规、采购验收和检测引用中，需要特别关注标准状态和替代关系。'
    : `${escapeHtml(prefix)} 前缀可作为标准体系检索入口；同一前缀下的标准不一定属于同一业务场景，仍需结合名称、分类和发布信息判断。`
  return `<section>
<h2>标准号解析</h2>
<p>${escapeHtml(row.code)} 的标准号可拆成前缀 ${escapeHtml(prefix)}、主序号 ${escapeHtml(num)} 和年份 ${escapeHtml(year)}。前缀用于识别标准体系，主序号常用于在同一体系内快速定位相邻标准，年份则是判断版本新旧的重要线索。${forceText}</p>
<p>当页面缺少完整 ICS、CCS 或组织字段时，标准号本身仍然能提供检索方向：先用 ${escapeHtml(prefix)} ${escapeHtml(num)} 锁定标准，再用名称中的关键词「${escapeHtml(row.name || row.code)}」缩小主题范围，最后结合状态字段判断是否适合继续引用。</p>
</section>`
}

function buildHtml(row, related, byCode) {
  const canonical = linkFor(row)
  const title = `${row.code} ${row.name || ''} - 标准小智`
  const desc = [
    row.name,
    `标准号 ${row.code}`,
    row.status && `状态：${row.status}`,
    row.pub_date && `发布日期：${row.pub_date}`,
    row.impl_date && `实施日期：${row.impl_date}`,
  ].filter(Boolean).join('，')
  const keywords = [row.code, row.name, row.ics_name, row.ccs_name, row.tc_committee, '标准查询'].filter(Boolean).join(', ')

  const blocks = [
    overview(row),
    organizationBlock(row),
    replacementBlock(row, byCode),
    relatedList('同 ICS 分类相关标准', related.ics),
    relatedList('同 CCS 分类相关标准', related.ccs),
    relatedList('同归口单位相关标准', related.tc),
    relatedList('同标准体系相关标准', related.prefix),
    numberBlock(row),
    scenarioBlock(row),
    usageBlock(row),
  ].filter(Boolean).join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeAttr(desc)}">
<meta name="keywords" content="${escapeAttr(keywords)}">
<meta name="generator" content="标准小智 pSEO priority">
<link rel="canonical" href="${escapeAttr(canonical)}">
<meta property="og:title" content="${escapeAttr(title)}">
<meta property="og:description" content="${escapeAttr(desc)}">
<meta property="og:url" content="${escapeAttr(canonical)}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="标准小智">
<script type="application/ld+json">${buildJsonLd(row, canonical)}</script>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;max-width:920px;margin:0 auto;padding:28px 18px;color:#222;line-height:1.72}
h1{font-size:28px;margin:0 0 6px;color:#123}
h2{font-size:20px;margin:30px 0 10px;color:#1f3b57}
.code{color:#666;font-size:15px;margin-bottom:24px}
dl{display:grid;grid-template-columns:130px 1fr;gap:8px 18px;margin:18px 0;padding:18px;background:#f7f9fc;border:1px solid #e8edf5}
dt{color:#607086;font-weight:600}
dd{margin:0;word-break:break-word}
p{margin:8px 0;color:#333}
ul{margin:8px 0 0 22px;padding:0}
li{margin:4px 0}
a{color:#0052d9;text-decoration:none}
a:hover{text-decoration:underline}
.cta{margin-top:30px;padding:16px;background:#f0f5ff;text-align:center}
.cta a{font-weight:700}
.foot{margin-top:42px;padding-top:16px;border-top:1px solid #eee;font-size:12px;color:#888;text-align:center}
</style>
<meta name="baidu-site-verification" content="codeva-CuoMihYoFG" />
<script>
var _hmt = _hmt || [];
(function(){var hm=document.createElement("script");hm.src="https://hm.baidu.com/hm.js?d9051828e0a1934884786a52323d32f6";var s=document.getElementsByTagName("script")[0];s.parentNode.insertBefore(hm,s);})();
</script>
</head>
<body>
<main>
<h1>${escapeHtml(row.name || row.code)}</h1>
<div class="code">${escapeHtml(row.code)}</div>
${metadataTable(row)}
${blocks}
<div class="cta"><a href="${escapeAttr(canonical)}">查看完整信息</a></div>
<div class="foot">本页仅展示标准元数据和站内相关标准链接，不含标准全文。© 标准小智</div>
</main>
</body>
</html>
`
}

function visibleTextLength(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '')
    .length
}

function main() {
  if (!fs.existsSync(INPUT)) throw new Error(`missing input: ${INPUT}`)
  if (!fs.existsSync(PRIORITY_URLS)) throw new Error(`missing priority URLs: ${PRIORITY_URLS}`)

  const standards = JSON.parse(fs.readFileSync(INPUT, 'utf8')).standards
  const idx = normalizeRows(standards)
  const slugs = fs.readFileSync(PRIORITY_URLS, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.includes('/standards/'))
    .map(line => line.split('/').pop())
    .filter(Boolean)

  const uniqueSlugs = [...new Set(slugs)]
  const targetSlugs = LIMIT > 0 ? uniqueSlugs.slice(0, LIMIT) : uniqueSlugs

  let written = 0
  let missing = 0
  let minText = Infinity
  let minSlug = ''
  const short = []

  for (const slug of targetSlugs) {
    const row = idx.bySlug.get(slug)
    if (!row) { missing++; continue }
    const related = {
      ics: relatedFrom(idx.byIcs, row.ics_code, row, 8),
      ccs: relatedFrom(idx.byCcs, row.ccs, row, 8),
      tc: relatedFrom(idx.byTc, row.tc_committee, row, 8),
      prefix: relatedByNumber(idx.byPrefix, codePrefix(row.code), row, 8),
    }
    const html = buildHtml(row, related, idx.byCode)
    const len = visibleTextLength(html)
    if (len < minText) { minText = len; minSlug = slug }
    if (len < 1000 && short.length < 20) short.push({ slug, code: row.code, visibleText: len })
    fs.writeFileSync(path.join(OUT_DIR, `${slug}.html`), html)
    written++
  }

  console.log(`written=${written}`)
  console.log(`missing=${missing}`)
  console.log(`min_visible_text=${minText} slug=${minSlug}`)
  if (short.length) {
    console.log('short_samples=' + JSON.stringify(short))
  }
}

main()
