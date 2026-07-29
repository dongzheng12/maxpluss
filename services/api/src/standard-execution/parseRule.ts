/**
 * standard-execution / RULE 模式解析（doc §七.1 降级兜底）
 *
 * 纯函数实现：拿 rawText → 返回 RequirementDraft[]。
 * 不依赖 prisma / network / env，便于单元测试。
 *
 * 算法：
 *   1. 把 rawText 按条款编号正则切片（第X条 / X.X / X.X.X / （一） / a) b)）
 *   2. 每段扫描关键词（强约束 + 描述性动词，作"推荐匹配"而非硬过滤）
 *   3. 命中关键词、或有条款编号且正文 ≥15 字（描述性条款）→ 生成草稿；
 *      过短 / 无编号且无关键词 → 跳过
 *
 * title 截取规则（用户决策 S4）：≤ 20 字 + 省略号（与 AI 模式 15 字视觉靠近）
 */
import type { RequirementDraft } from './types.js'

const TITLE_MAX_LEN = 20

// 关键词（doc §七.1 RULE 模式列表）。准确优先：没有动作/约束词的章节标题和定义段不生成草稿。
const STRONG_KEYWORDS = [
  '应当', '应', '必须', '不得', '禁止', '需要', '确保', '定期', '每月',
  '每季度', '记录', '检查', '培训', '留存', '备案', '报备', '提交',
  '确认',
  '建立', '制定', '明确', '配备', '开展', '组织', '评估', '评审',
  '监视', '测量', '控制', '识别', '分类', '标识', '处置', '整改', '验证',
  '考核', '提供', '设置', '编制', '实施', '保持', '维护', '形成', '分解',
]
const STRONG_KEYWORDS_RE = new RegExp(STRONG_KEYWORDS.join('|'))

// 条款编号正则（优先级从严到松；行首匹配）
// 注意：以下正则在切片时只用来定位起点，捕获 group[1] 是条款编号
const CLAUSE_REGEXES: Array<{ name: string; re: RegExp }> = [
  { name: 'chinese', re: /(?:^|\n)\s*(第[一二三四五六七八九十百零\d]+条)/g },
  { name: 'dotted', re: /(?:^|\n)\s*(\d+(?:\.\d+){1,3})\s*[、.\s]/g },
  { name: 'paren-zh', re: /(?:^|\n)\s*([（(][一二三四五六七八九十\d]+[）)])/g },
  { name: 'paren-alpha', re: /(?:^|\n)\s*([a-zA-Z][)）])/g },
]

interface Segment {
  clauseNo: string | null
  text: string
}

function normalizeLooseDottedClause(clauseNo: string): string {
  return clauseNo.replace(/\s+/g, '')
}

export function normalizeStandardTextForParsing(rawText: string): string {
  return rawText
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    // PDF reader may split every CJK character with spaces: "智 能 终 端" -> "智能终端".
    .replace(/(?<=\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, '')
    // Recover common spaced numeric/standard-code forms: "5 . 1 . 4", "2 0 2 5", "IP 6 5".
    .replace(/(?<=\d)[ \t]*\.[ \t]*(?=\d)/g, '.')
    .replace(/(?<=\d)[ \t]+(?=\d)/g, '')
    .replace(/(?<=[A-Za-z])[ \t]+(?=[A-Za-z0-9])/g, '')
    .replace(/(?<=[A-Za-z0-9])[ \t]+(?=[A-Za-z])/g, '')
    // Put dotted clauses onto their own line even when extraction flattens headings and text.
    .replace(/(^|[^\d.])(\d+(?:\.\d+){1,3})(?=\s*[\u4e00-\u9fffA-Za-z])/g, '$1\n$2 ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 切片：按条款编号将 rawText 分段。
 * 任一编号体系命中 → 用第一个命中的正则切。没命中 → 整篇当一段。
 */
function sliceByClause(rawText: string): Segment[] {
  for (const { re } of CLAUSE_REGEXES) {
    re.lastIndex = 0
    const matches = [...rawText.matchAll(re)]
    if (matches.length === 0) continue

    const segments: Segment[] = []
    // 第一个 match 之前的文字丢弃（多数是前言/标题），从第一个编号开始切
    for (let i = 0; i < matches.length; i++) {
      const m = matches[i]
      const clauseNo = m[1] ? normalizeLooseDottedClause(m[1]) : null
      const startIdx = (m.index ?? 0) + m[0].length
      const endIdx = i + 1 < matches.length ? (matches[i + 1].index ?? rawText.length) : rawText.length
      const text = rawText.slice(startIdx, endIdx).trim()
      segments.push({ clauseNo, text })
    }
    return segments
  }
  return [{ clauseNo: null, text: rawText.trim() }]
}

function makeTitle(text: string): string {
  const t = text.replace(/\s+/g, '').trim()
  if (t.length <= TITLE_MAX_LEN) return t
  return t.slice(0, TITLE_MAX_LEN) + '…'
}

function makeTaskTitle(text: string): string {
  const core = text
    .replace(/^(企业|单位|部门|人员|相关岗位|保安服务公司|保安员)/, '')
    .replace(/[。；;].*$/, '')
    .replace(/\s+/g, '')
    .slice(0, 32)
  return core ? makeTitle(`落实${core}`) : makeTitle(text)
}

function inferMaterials(text: string): string[] {
  const materials = new Set<string>()
  if (/培训|考核/.test(text)) {
    materials.add('培训签到表')
    materials.add('考核记录')
  }
  if (/记录|台账|留存|保存|备案|报备/.test(text)) {
    materials.add('执行记录或台账')
  }
  if (/检查|巡查|监视|测量|评估|评审|整改|验证/.test(text)) {
    materials.add('现场检查记录')
    materials.add('照片或整改凭证')
  }
  if (/制度|方案|计划|规程|文件|制定|编制/.test(text)) {
    materials.add('制度文件或方案')
  }
  if (materials.size === 0) materials.add('完成说明及必要证明材料')
  return Array.from(materials)
}

function enrichExecutableFields(draft: RequirementDraft): RequirementDraft {
  const text = draft.requirementText.trim()
  const materials = inferMaterials(text)
  return {
    ...draft,
    title: makeTaskTitle(text),
    executionDescription: `请按原文要求执行并留痕：${text}`,
    submitRequirement: `提交${materials.join('、')}，并说明执行时间、责任人和完成情况。`,
    requiredMaterials: materials,
  }
}

function isPlausibleClauseNo(clauseNo: string | null): boolean {
  if (!clauseNo) return true
  const firstPart = Number(clauseNo.match(/^\d+/)?.[0] ?? NaN)
  // Skip ICS/CCS classification-like values such as 29.120.40.
  return Number.isNaN(firstPart) || firstPart <= 20
}

export function parseByRule(rawText: string): RequirementDraft[] {
  if (!rawText || !rawText.trim()) return []

  const normalizedText = normalizeStandardTextForParsing(rawText)
  const segments = sliceByClause(normalizedText)
  const drafts: RequirementDraft[] = []
  const seen = new Set<string>()
  for (const seg of segments) {
    if (!isPlausibleClauseNo(seg.clauseNo)) continue
    const text = seg.text.trim()
    if (text.length < 5) continue              // 过短跳过
    const hasKeyword = STRONG_KEYWORDS_RE.test(text)
    if (!hasKeyword) continue

    const dedupeKey = `${seg.clauseNo ?? ''}:${text.slice(0, 80)}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    drafts.push(enrichExecutableFields({
      clauseNo: seg.clauseNo,
      title: makeTitle(text),
      requirementText: text,
    }))
  }
  return drafts
}
