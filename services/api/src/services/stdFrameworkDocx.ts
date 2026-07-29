/**
 * 标准框架 Word 导出 — Phase C-3 / 方案 §3.3
 *
 * 将 LLM 生成的标准框架 Markdown 文本渲染成 docx Buffer。
 * 解析规则刻意简单（不引入额外 md 解析器）：
 *  - `# / ## / ### 标题`  → HeadingLevel.HEADING_1/2/3
 *  - `**加粗**` 行内      → TextRun bold
 *  - `- item` / `* item`  → BulletList 项
 *  - `1. item` 顶层数字   → 普通段落（标准章节本身就是数字编号，无需 ordered list 样式）
 *  - 空行                → 段落分隔
 *  - 其他                → 普通段落
 *
 * 文末固定追加：
 *  - 免责声明
 *  - 已验证 / 待核实编号列表（references 可选）
 */
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
} from 'docx'
import type { VerifiedItem, UnverifiedItem } from './stdReferenceValidator.js'

export interface BuildStdFrameworkDocxInput {
  title?: string
  content: string
  references?: { verified: VerifiedItem[]; unverified: UnverifiedItem[] }
  generatedAt?: Date
}

const DISCLAIMER =
  '本文件由「标准小智」AI 辅助起草，仅供编写参考；不构成正式标准、不可作为合规或检测依据。请由具备资质的专家完成审核与定稿。'

/**
 * 把一行 markdown 文本按 `**xxx**` 切分成 TextRun 数组。
 * 不做完整 inline 解析，只够支撑「**加粗**」即可。
 */
function inlineRuns(text: string): TextRun[] {
  if (!text) return [new TextRun({ text: '' })]
  const parts = text.split(/(\*\*[^*]+\*\*)/)
  const runs: TextRun[] = []
  for (const p of parts) {
    if (!p) continue
    if (p.startsWith('**') && p.endsWith('**')) {
      runs.push(new TextRun({ text: p.slice(2, -2), bold: true }))
    } else {
      runs.push(new TextRun({ text: p }))
    }
  }
  return runs.length > 0 ? runs : [new TextRun({ text })]
}

/**
 * 把整段 markdown 转成 docx Paragraph 数组。
 */
export function markdownToParagraphs(md: string): Paragraph[] {
  const lines = (md || '').split(/\r?\n/)
  const out: Paragraph[] = []
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) {
      out.push(new Paragraph({ children: [new TextRun({ text: '' })] }))
      continue
    }
    // 标题
    const h = line.match(/^(#{1,3})\s+(.+)$/)
    if (h) {
      const level = h[1].length
      const headingLevel =
        level === 1
          ? HeadingLevel.HEADING_1
          : level === 2
            ? HeadingLevel.HEADING_2
            : HeadingLevel.HEADING_3
      out.push(new Paragraph({ heading: headingLevel, children: inlineRuns(h[2]) }))
      continue
    }
    // 列表项 - * +
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/)
    if (bullet) {
      out.push(new Paragraph({ bullet: { level: 0 }, children: inlineRuns(bullet[1]) }))
      continue
    }
    out.push(new Paragraph({ children: inlineRuns(line) }))
  }
  return out
}

function referencesSection(
  refs: BuildStdFrameworkDocxInput['references'],
): Paragraph[] {
  if (!refs || (refs.verified.length === 0 && refs.unverified.length === 0)) return []
  const out: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: '附：引用标准编号核验结果' })],
    }),
  ]
  if (refs.verified.length > 0) {
    out.push(
      new Paragraph({
        children: [new TextRun({ text: `✓ 已核验（共 ${refs.verified.length} 条）`, bold: true })],
      }),
    )
    for (const v of refs.verified) {
      out.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: `${v.code}  ${v.title}（${v.status}）` })],
        }),
      )
    }
  }
  if (refs.unverified.length > 0) {
    out.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `✗ 未在标准库中检索到（共 ${refs.unverified.length} 条，请人工复核）`,
            bold: true,
          }),
        ],
      }),
    )
    for (const u of refs.unverified) {
      out.push(
        new Paragraph({
          bullet: { level: 0 },
          children: [new TextRun({ text: `${u.code}（${reasonLabel(u.reason)}）` })],
        }),
      )
    }
  }
  return out
}

function reasonLabel(r: UnverifiedItem['reason']): string {
  if (r === 'not_found') return '未找到'
  if (r === 'timeout') return '查询超时'
  return '查询失败'
}

function fmt(d: Date): string {
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

/**
 * 主入口：构造 docx Buffer。
 */
export async function buildStdFrameworkDocx(input: BuildStdFrameworkDocxInput): Promise<Buffer> {
  const generatedAt = input.generatedAt || new Date()
  const titleText = input.title?.trim() || '标准文本框架（AI 辅助起草）'

  const children: Paragraph[] = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: titleText, bold: true })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: `生成时间：${fmt(generatedAt)}`, italics: true })],
    }),
    new Paragraph({ children: [new TextRun({ text: '' })] }),
    ...markdownToParagraphs(input.content),
    new Paragraph({ children: [new TextRun({ text: '' })] }),
    ...referencesSection(input.references),
    new Paragraph({ children: [new TextRun({ text: '' })] }),
    new Paragraph({
      heading: HeadingLevel.HEADING_2,
      children: [new TextRun({ text: '免责说明' })],
    }),
    new Paragraph({ children: [new TextRun({ text: DISCLAIMER })] }),
  ]

  const doc = new Document({
    creator: '标准小智',
    title: titleText,
    sections: [{ properties: {}, children }],
  })
  return Packer.toBuffer(doc)
}
