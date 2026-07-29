/**
 * 专家评审意见与投票结果确认单 — DOCX 生成
 *
 * 用 docx 库生成《专家评审意见与投票结果确认单》.docx 文件。
 * - 中文友好（无需嵌入字体）
 * - 纯 JS，无 Chromium 依赖
 * - 输出 buffer，由调用方写盘
 *
 * 第一版口径：免责声明明确"不作为行政许可、强制认证、法定检测、司法鉴定或其他具有强制法律效力的结论"。
 */
import {
  Document, Packer, Paragraph, TextRun, AlignmentType, HeadingLevel,
  Table, TableRow, TableCell, WidthType, BorderStyle,
} from 'docx'

const VOTE_RESULT_LABEL: Record<string, string> = {
  PASS: '通过',
  REJECT: '不通过',
  PASS_WITH_MOD: '修改后通过',
  ABSTAIN: '弃权',
}
const CONCLUSION_LABEL: Record<string, string> = {
  PASS: '通过',
  REJECT: '不通过',
  PASS_WITH_MOD: '修改后通过',
  NEED_SUPPLEMENT: '建议补充材料后再次评审',
}

interface ExpertWithRecord {
  expertName: string
  expertOrg?: string | null
  expertTitle?: string | null
  expertField?: string | null
  voteResult?: string
  reviewOpinion?: string
  modificationSuggestion?: string | null
  riskWarning?: string | null
}

export interface BuildResultDocxInput {
  requestNo: string
  projectName: string
  applicantOrg?: string | null
  applicantName?: string | null
  applicantPhone?: string | null
  meetingTitle?: string | null
  meetingStartAt?: Date | null
  meetingEndAt?: Date | null
  conclusion?: string | null
  conclusionRemark?: string | null
  voteSummary?: { PASS: number; REJECT: number; PASS_WITH_MOD: number; ABSTAIN: number; total: number }
  experts: ExpertWithRecord[]
}

const fmt = (d: Date | null | undefined): string =>
  d ? new Date(d).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '-'

function pad(n: number): string { return String(n).padStart(2, '0') }
function fileDateStr(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

function p(text: string, opts: { bold?: boolean; size?: number; align?: any } = {}): Paragraph {
  return new Paragraph({
    alignment: opts.align,
    children: [new TextRun({ text, bold: opts.bold, size: opts.size })],
  })
}

function kvRow(k: string, v: string): TableRow {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 25, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: k, bold: true })] })],
      }),
      new TableCell({
        width: { size: 75, type: WidthType.PERCENTAGE },
        children: [new Paragraph({ children: [new TextRun({ text: v || '-' })] })],
      }),
    ],
  })
}

export async function buildResultConfirmationDocx(input: BuildResultDocxInput): Promise<Buffer> {
  const now = new Date()
  const fileNo = `EVR-${input.requestNo}-DOC-${fileDateStr(now)}`

  const sections: any[] = []

  // 页眉风格的副标题
  sections.push(p('标准小智 · 专家评审服务', { align: AlignmentType.CENTER, size: 20 }))

  // 大标题
  sections.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text: '专家评审意见与投票结果确认单', bold: true, size: 36 })],
  }))

  sections.push(p(`文件编号：${fileNo}`, { align: AlignmentType.CENTER, size: 20 }))
  sections.push(p(`生成时间：${fmt(now)}`, { align: AlignmentType.CENTER, size: 20 }))
  sections.push(new Paragraph({ children: [new TextRun({ text: '' })] })) // 空行

  // 一、基本信息
  sections.push(p('一、基本信息', { bold: true, size: 26 }))
  sections.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      kvRow('申请编号', input.requestNo),
      kvRow('评审项目名称', input.projectName),
      kvRow('申请单位', input.applicantOrg || '-'),
      kvRow('申请联系人', input.applicantName || '-'),
      kvRow('联系电话', input.applicantPhone || '-'),
      kvRow('会议主题', input.meetingTitle || '-'),
      kvRow('会议时间', `${fmt(input.meetingStartAt)} — ${fmt(input.meetingEndAt)}`),
    ],
  }))
  sections.push(new Paragraph({ children: [new TextRun({ text: '' })] }))

  // 二、投票结果汇总
  sections.push(p('二、投票结果汇总', { bold: true, size: 26 }))
  const s = input.voteSummary || { PASS: 0, REJECT: 0, PASS_WITH_MOD: 0, ABSTAIN: 0, total: 0 }
  sections.push(new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      kvRow('通过票数', String(s.PASS)),
      kvRow('不通过票数', String(s.REJECT)),
      kvRow('修改后通过票数', String(s.PASS_WITH_MOD)),
      kvRow('弃权票数', String(s.ABSTAIN)),
      kvRow('参与专家总数', String(s.total)),
      kvRow('最终结论', CONCLUSION_LABEL[input.conclusion || ''] || '-'),
      ...(input.conclusionRemark ? [kvRow('结论说明', input.conclusionRemark)] : []),
    ],
  }))
  sections.push(new Paragraph({ children: [new TextRun({ text: '' })] }))

  // 三、专家意见与签名
  sections.push(p('三、专家意见与签名', { bold: true, size: 26 }))
  for (let i = 0; i < input.experts.length; i++) {
    const e = input.experts[i]
    sections.push(new Paragraph({ children: [new TextRun({ text: '' })] }))
    sections.push(p(`${i + 1}. 专家信息`, { bold: true, size: 22 }))
    sections.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      rows: [
        kvRow('姓名', e.expertName),
        kvRow('单位', e.expertOrg || '-'),
        kvRow('职称', e.expertTitle || '-'),
        kvRow('专业方向', e.expertField || '-'),
        kvRow('投票结果', VOTE_RESULT_LABEL[e.voteResult || ''] || '未录入'),
      ],
    }))
    sections.push(p('专家意见：', { bold: true }))
    sections.push(p(e.reviewOpinion || '（未录入）'))
    if (e.modificationSuggestion) {
      sections.push(p('修改建议：', { bold: true }))
      sections.push(p(e.modificationSuggestion))
    }
    if (e.riskWarning) {
      sections.push(p('风险提示：', { bold: true }))
      sections.push(p(e.riskWarning))
    }
    sections.push(new Paragraph({ children: [new TextRun({ text: '' })] }))
    sections.push(p('专家签名：____________________________      日期：__________________'))
    sections.push(new Paragraph({
      border: { bottom: { color: 'auto', space: 1, style: BorderStyle.SINGLE, size: 6 } },
      children: [new TextRun({ text: '' })],
    }))
  }

  // 四、免责声明
  sections.push(new Paragraph({ children: [new TextRun({ text: '' })] }))
  sections.push(p('免责声明：', { bold: true, size: 18 }))
  sections.push(p(
    '本确认单仅用于记录本次专家评审投票服务的组织过程及专家意见、投票结果汇总，' +
    '不作为行政许可、强制认证、法定检测、司法鉴定或其他具有强制法律效力的结论文件。',
    { size: 18 },
  ))

  const doc = new Document({
    sections: [{ children: sections }],
  })
  return await Packer.toBuffer(doc)
}
