import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { prisma } from '../db.js'
import { resolveRequirementBasis } from './basisSnapshots.js'

const PDF_FONT_CANDIDATES = [
  '/app/assets/fonts/NotoSansSC-Regular.otf',
  'assets/fonts/NotoSansSC-Regular.otf',
  'services/api/assets/fonts/NotoSansSC-Regular.otf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
]

function compactText(input: string | null | undefined, max = 100) {
  const text = String(input || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}...` : text
}

function safeFileSegment(input: unknown, fallback: string) {
  const value = String(input || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
  return value || fallback
}

function formatDate(value: Date | string | null | undefined, withTime = true) {
  if (!value) return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const iso = date.toISOString()
  return withTime ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10)
}

function wrapLine(line: string, maxChars: number) {
  if (line.length <= maxChars) return [line]
  const out: string[] = []
  for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars))
  return out
}

function sanitizeForStandardFont(text: string) {
  return text.replace(/[^\x20-\x7E]/g, '?')
}

function hasNonAscii(text: string) {
  return /[^\x00-\x7F]/.test(text)
}

export async function loadRecordEvidenceChain(enterpriseId: string, recordId: string) {
  const record = await prisma.standardExecutionRecord.findFirst({
    where: { id: recordId, enterpriseId },
    include: {
      submission: true,
      task: { include: { requirement: { include: { source: true } } } },
    },
  })
  if (!record) return null

  const [enterprise, assigneeRow, reviewLogs, attachments] = await Promise.all([
    prisma.enterprise.findUnique({ where: { id: enterpriseId }, select: { id: true, name: true } }),
    prisma.standardExecutionTaskAssignee.findFirst({
      where: { enterpriseId, taskId: record.taskId, assigneeId: record.assigneeId },
      select: { status: true, departmentId: true, reviewerId: true, submittedAt: true, reviewedAt: true },
    }),
    prisma.standardExecutionReviewLog.findMany({
      where: { enterpriseId, submissionId: record.submissionId },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.standardExecutionAttachment.findMany({
      where: { enterpriseId, bizType: 'SUBMISSION', bizId: record.submissionId },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const basis = resolveRequirementBasis(record.task.basisSnapshots, record.requirementId, record.task.requirement)
  const requirement = basis?.requirement ?? record.task.requirement
  const source = requirement?.source ?? record.task.requirement?.source
  const latestReviewLog = [...reviewLogs].reverse().find((log) => log.action === 'APPROVE') ?? reviewLogs[reviewLogs.length - 1]

  return {
    enterprise: {
      id: enterpriseId,
      name: enterprise?.name ?? enterpriseId,
    },
    source: {
      id: record.sourceId,
      sourceNo: source?.sourceNo ?? null,
      title: source?.title ?? '未标记标准文档',
      version: source?.version ?? null,
      sourceType: source?.sourceType ?? null,
    },
    requirement: {
      id: record.requirementId,
      clauseNo: requirement?.clauseNo ?? null,
      title: requirement?.title ?? '未标记控制点',
      requirementText: requirement?.requirementText ?? '',
      requirementTextSummary: compactText(requirement?.requirementText, 100),
    },
    task: {
      id: record.taskId,
      title: record.task.title,
      status: record.task.status,
      deadlineAt: record.task.deadlineAt,
      assigneeId: record.assigneeId,
      reviewerId: record.task.reviewerId ?? assigneeRow?.reviewerId ?? record.submission.reviewerId,
      assigneeStatus: assigneeRow?.status ?? null,
      departmentId: record.departmentId ?? assigneeRow?.departmentId ?? null,
    },
    submission: {
      id: record.submissionId,
      assigneeId: record.submission.assigneeId,
      submitText: record.submission.submitText,
      submitTextSummary: compactText(record.submission.submitText, 160),
      status: record.submission.status,
      version: record.submission.version,
      submittedAt: record.submission.submittedAt,
    },
    review: {
      reviewerId: record.submission.reviewerId ?? latestReviewLog?.reviewerId ?? record.task.reviewerId ?? assigneeRow?.reviewerId ?? null,
      reviewedAt: record.submission.reviewedAt ?? latestReviewLog?.createdAt ?? assigneeRow?.reviewedAt ?? null,
      reviewComment: record.submission.reviewComment ?? latestReviewLog?.comment ?? null,
      logs: reviewLogs,
    },
    record: {
      id: record.id,
      title: record.title,
      summary: record.summary,
      recordDate: record.recordDate,
      validUntil: record.validUntil,
      status: record.status,
      createdFrom: record.createdFrom,
      createdAt: record.createdAt,
    },
    attachments,
  }
}

export type RecordEvidenceChain = NonNullable<Awaited<ReturnType<typeof loadRecordEvidenceChain>>>

export function recordEvidencePdfFilename(chain: RecordEvidenceChain) {
  const enterprise = safeFileSegment(chain.enterprise.name, '企业')
  const clause = safeFileSegment(chain.requirement.clauseNo || chain.requirement.id.slice(0, 8), '控制点')
  const date = formatDate(chain.record.recordDate, false) || new Date().toISOString().slice(0, 10)
  return `${enterprise}-${clause}-${date}-证据.pdf`
}

export function buildRecordEvidenceText(chain: RecordEvidenceChain) {
  return [
    `# ${chain.record.title}`,
    '',
    `企业：${chain.enterprise.name}`,
    `记录状态：${chain.record.status}`,
    `记录日期：${formatDate(chain.record.recordDate)}`,
    `有效期至：${formatDate(chain.record.validUntil) || '未设置'}`,
    '',
    '## 证据链',
    `[标准来源] ${[chain.source.sourceNo, chain.source.title].filter(Boolean).join(' ')}`,
    `  └─ [控制点] ${[chain.requirement.clauseNo, chain.requirement.title].filter(Boolean).join(' ')}｜${chain.requirement.requirementTextSummary || '无摘要'}`,
    `       └─ [执行任务] ${chain.task.title}｜执行人 ${chain.task.assigneeId}｜截止 ${formatDate(chain.task.deadlineAt) || '未设置'}`,
    `            └─ [提交] ${formatDate(chain.submission.submittedAt)}｜提交人 ${chain.submission.assigneeId}｜v${chain.submission.version}`,
    `                 └─ [审核] 审核人 ${chain.review.reviewerId || '未记录'}｜${formatDate(chain.review.reviewedAt) || '未记录'}｜${chain.review.reviewComment || '暂无审核意见'}`,
    `                      └─ [本条记录] 入库 ${formatDate(chain.record.createdAt)}｜有效期 ${formatDate(chain.record.validUntil) || '未设置'}`,
    '',
    '## 提交摘要',
    chain.submission.submitTextSummary || '暂无提交摘要',
    '',
    '## 附件',
    ...(chain.attachments.length
      ? chain.attachments.map((file, index) => `${index + 1}. ${file.fileName} ${file.fileUrl}`)
      : ['无附件']),
  ].join('\n')
}

export async function buildRecordEvidencePdfBuffer(chain: RecordEvidenceChain) {
  const pdf = await PDFDocument.create()
  let font = await pdf.embedFont(StandardFonts.Helvetica)
  let hasCustomFont = false
  pdf.registerFontkit(fontkit)
  for (const candidate of PDF_FONT_CANDIDATES) {
    if (!existsSync(candidate) || !/\.(otf|ttf)$/i.test(candidate)) continue
    try {
      font = await pdf.embedFont(await readFile(candidate))
      hasCustomFont = true
      break
    } catch {
      // Helvetica fallback below.
    }
  }

  const text = buildRecordEvidenceText(chain)
  if (!hasCustomFont && hasNonAscii(text)) {
    throw Object.assign(new Error('PDF_CJK_FONT_MISSING'), { status: 500 })
  }

  const pageWidth = 595.28
  const pageHeight = 841.89
  const margin = 48
  const fontSize = 11
  const lineHeight = 17
  let page = pdf.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin

  const draw = (raw: string, size = fontSize) => {
    const textLine = hasCustomFont ? raw : sanitizeForStandardFont(raw)
    for (const wrapped of wrapLine(textLine, size > fontSize ? 34 : 58)) {
      if (y < margin) {
        page = pdf.addPage([pageWidth, pageHeight])
        y = pageHeight - margin
      }
      const isHeading = wrapped.startsWith('#')
      page.drawText(wrapped.replace(/^#+\s*/, '') || ' ', {
        x: margin,
        y,
        size: isHeading ? (wrapped.startsWith('# ') ? 18 : 13) : size,
        font,
        color: isHeading ? rgb(0.05, 0.18, 0.32) : rgb(0.12, 0.12, 0.12),
      })
      y -= isHeading ? lineHeight + 4 : lineHeight
    }
  }

  for (const line of text.split(/\r?\n/)) draw(line)
  return Buffer.from(await pdf.save())
}
