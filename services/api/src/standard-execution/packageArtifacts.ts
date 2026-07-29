import { existsSync } from 'fs'
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import path from 'path'
import * as XLSX from 'xlsx'
import JSZip from 'jszip'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'
import { prisma } from '../db.js'
import { markdownToParagraphs } from '../services/stdFrameworkDocx.js'
import { resolveRequirementBasis } from './basisSnapshots.js'
import { PACKAGE_OUTPUT_DIR } from './packageBundle.js'
import type { PackageGenerationOptionsInput } from './types.js'

export type PackageOutputKind = 'docx' | 'xlsx' | 'txt' | 'json' | 'zip' | 'pdf' | 'file'

export interface PackageOutputFile {
  path: string
  kind: PackageOutputKind
  label: string
  size: number
  required: boolean
}

export interface PackagePreview {
  package: {
    id: string
    title: string
    packageScene: string
    description: string | null
    dateFrom: string | null
    dateTo: string | null
  }
  cover: {
    reportTitle: string
    enterpriseName: string
    packageSceneLabel: string
    auditDateRange: string
    generatedBy: string
    generatedAt: string
  }
  stats: {
    recordCount: number
    taskCount: number
    requirementCount: number
    sourceCount: number
    attachmentCount: number
  }
  attachmentCounts: Record<'image' | 'pdf' | 'video' | 'contract' | 'other', number>
  missingAttachments: Array<{
    recordId: string
    recordTitle: string
    taskId: string
    taskTitle: string
    reason: string
  }>
  bodySections: string[]
  outputFileTree: Array<{
    path: string
    kind: PackageOutputKind
    label: string
    required: boolean
  }>
  previewItems: Array<{
    key: string
    label: string
    status: 'OK' | 'WARN' | 'BLOCKED'
    value: string | number | boolean | null
  }>
  directoryTree: string[]
  reportStructurePreview: string[]
  invalidRecordRisk: {
    hasInvalidRecord: boolean
    invalidRecordCount: number
    invalidRecordIds: string[]
  }
  attachmentIndexPreview: AttachmentIndexRow[]
  v2Options: Required<PackageGenerationOptionsInput>
  estimatedOutputSize: number
}

interface AttachmentIndexRow {
  fileName: string
  type: string
  size: number | null
  uploadedBy: string
  uploadedAt: string
  taskTitle: string
  recordTitle: string
  relativePath: string
}

interface AuditTraceRow {
  source: string
  requirement: string
  task: string
  submitter: string
  reviewer: string
  submittedAt: string
  reviewedAt: string
  files: string
}

interface BundlePackage {
  id: string
  enterpriseId: string
  title: string
  packageScene: string
  description: string | null
  dateFrom: Date | null
  dateTo: Date | null
  status: string
  format: string
  hasInvalidRecord: boolean
  generatedAt: Date | null
  fileUrl: string | null
  createdBy: string
  createdAt: Date
  updatedAt: Date
  items: BundleEntry['item'][]
}

interface BundleData {
  pkg: BundlePackage
  enterpriseName: string
  userMap: Map<string, { id: string; name: string | null; phone: string | null }>
  entries: BundleEntry[]
}

interface BundleEntry {
  index: number
  item: {
    id: string
    recordId: string
    requirementId: string
    taskId: string
    submissionId: string
    sortNo: number
  }
  record: {
    id: string
    title: string
    status: string
    summary: string | null
    recordDate: Date
    departmentId: string | null
  }
  submission: {
    id: string
    submitText: string
    submitDataJson: unknown
    status: string
    submittedAt: Date
    reviewedAt: Date | null
    assigneeId: string
    reviewerId: string | null
    reviewComment: string | null
  }
  task: {
    id: string
    title: string
    description: string | null
    taskType: string | null
    submitRequirement: string | null
    deadlineAt: Date | null
    reviewerId: string | null
    status: string
    basisSnapshots: unknown
  }
  requirement: {
    id: string
    clauseNo?: string | null
    title?: string | null
    requirementText?: string | null
    submitRequirement?: string | null
    requiredMaterials?: unknown
  }
  source: {
    id?: string
    title?: string | null
    sourceNo?: string | null
    sourceType?: string | null
    version?: string | null
  }
  attachments: Array<{
    id: string
    fileName: string
    fileUrl: string
    fileSize: number | null
    mimeType: string | null
    uploadedBy: string
    createdAt: Date
  }>
  reviewLogs: Array<{
    id: string
    action: string
    reviewerId: string
    comment: string | null
    createdAt: Date
  }>
}

const BODY_SECTIONS = [
  '封面',
  '基本信息',
  '标准依据',
  '任务汇总',
  '记录明细',
  '证据清单',
  '审核与生成信息',
]

const DEFAULT_OPTIONS: Required<PackageGenerationOptionsInput> = {
  includeManifest: false,
  includeAuditTrace: false,
  includeBasisClauses: false,
  includeStatisticsSummary: false,
}

const FILE_REQUIRED_TASK_TYPES = new Set([
  'QUALIFICATION_MATERIAL',
  'ARCHIVE_MATERIAL',
  'INSPECTION_FILL',
  'RECTIFICATION',
  'DOCUMENT_UPLOAD',
])

const PACKAGE_SCENE_CN: Record<string, string> = {
  REGULATORY: '监管检查',
  CUSTOMER_AUDIT: '客户审厂',
  CERTIFICATION: '认证申请',
  INTERNAL_CHECK: '内部专项审计',
  TRAINING_ARCHIVE: '培训存档',
  OTHER: '其他',
}

const PDF_FONT_CANDIDATES = [
  '/app/assets/fonts/NotoSansSC-Regular.otf',
  'assets/fonts/NotoSansSC-Regular.otf',
  'services/api/assets/fonts/NotoSansSC-Regular.otf',
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
]

function normalizeOptions(input?: Partial<PackageGenerationOptionsInput>): Required<PackageGenerationOptionsInput> {
  return { ...DEFAULT_OPTIONS, ...(input ?? {}) }
}

function safeSegment(input: unknown, fallback: string) {
  const s = String(input || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
  return s || fallback
}

function packageReportTitle(title: string | null | undefined) {
  const safeTitle = String(title || '').trim() || '客户审计'
  const normalizedTitle = safeTitle.replace(/\u6750\u6599\u5305$/, '审计包')
  return /审计包$/.test(normalizedTitle) ? normalizedTitle : `${normalizedTitle}审计包`
}

function reviewActionLabel(action: string | null | undefined) {
  const labels: Record<string, string> = {
    APPROVE: '审核通过',
    REJECT: '审核驳回',
  }
  return labels[action || ''] || action || '-'
}

function fmtDate(value: Date | string | null | undefined) {
  if (!value) return '-'
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '-'
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
}

function fmtDateOnly(value: Date | string | null | undefined) {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString().slice(0, 10)
}

function auditDateRange(pkg: Pick<BundlePackage, 'dateFrom' | 'dateTo'>) {
  const from = fmtDateOnly(pkg.dateFrom)
  const to = fmtDateOnly(pkg.dateTo)
  if (from && to) return `${from} ~ ${to}`
  if (from) return `${from} 起`
  if (to) return `截至 ${to}`
  return '未设置'
}

function sceneLabel(scene: string | null | undefined) {
  return PACKAGE_SCENE_CN[scene || ''] || scene || '其他'
}

function sanitizeForStandardFont(text: string) {
  return text.replace(/[^\x20-\x7E]/g, '?')
}

function hasNonAscii(text: string) {
  return /[^\x00-\x7F]/.test(text)
}

function wrapLine(line: string, maxChars: number) {
  if (line.length <= maxChars) return [line]
  const out: string[] = []
  for (let i = 0; i < line.length; i += maxChars) out.push(line.slice(i, i + maxChars))
  return out
}

async function writePdf(filePath: string, title: string, lines: string[]) {
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
  const rawText = [title, ...lines].join('\n')
  if (!hasCustomFont && hasNonAscii(rawText)) {
    throw Object.assign(new Error('PDF_CJK_FONT_MISSING'), { status: 500 })
  }

  const pageWidth = 595.28
  const pageHeight = 841.89
  const margin = 48
  const fontSize = 11
  const lineHeight = 17
  const headingColor = rgb(0.05, 0.18, 0.32)
  const textColor = rgb(0.12, 0.12, 0.12)
  const warningColor = rgb(0.75, 0.08, 0.08)
  let page = pdf.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin
  const draw = (raw: string, size = fontSize, tone: 'text' | 'heading' | 'warning' = 'text') => {
    const text = hasCustomFont ? raw : sanitizeForStandardFont(raw)
    for (const wrapped of wrapLine(text, size > fontSize ? 34 : 58)) {
      if (y < margin) {
        page = pdf.addPage([pageWidth, pageHeight])
        y = pageHeight - margin
      }
      page.drawText(wrapped || ' ', {
        x: margin,
        y,
        size,
        font,
        color: tone === 'warning' ? warningColor : tone === 'heading' ? headingColor : textColor,
      })
      y -= size > fontSize ? lineHeight + 5 : lineHeight
    }
  }

  draw(title, 18, 'heading')
  y -= 8
  for (const line of lines) {
    if (line.startsWith('## ')) {
      y -= 4
      draw(line.replace(/^##\s+/, ''), 13, 'heading')
    } else if (/^警告[:：]/.test(line)) {
      draw(line, fontSize, 'warning')
    } else {
      draw(line)
    }
  }
  await writeFile(filePath, Buffer.from(await pdf.save()))
}

function localUploadPath(fileUrl: string) {
  if (!fileUrl.startsWith('/uploads/')) return null
  const uploadsRoot = path.resolve(process.cwd(), 'uploads')
  const filePath = path.resolve(process.cwd(), `.${fileUrl}`)
  if (!filePath.startsWith(uploadsRoot + path.sep)) return null
  return filePath
}

function userName(data: BundleData, id: string | null | undefined) {
  if (!id) return '-'
  const user = data.userMap.get(id)
  return user?.name || user?.phone || id
}

function jsonStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v || '').trim()).filter(Boolean)
}

function needsAttachment(entry: BundleEntry) {
  if (FILE_REQUIRED_TASK_TYPES.has(entry.task.taskType || '')) return true
  if (jsonStringArray(entry.requirement.requiredMaterials).length > 0) return true
  const text = [
    entry.task.submitRequirement,
    entry.requirement.submitRequirement,
    entry.requirement.requirementText,
  ].filter(Boolean).join('\n')
  return /附件|上传|图片|照片|证明|材料|文件|扫描件/i.test(text)
}

function attachmentType(fileName: string, mimeType: string | null | undefined): keyof PackagePreview['attachmentCounts'] {
  const name = fileName.toLowerCase()
  const mime = (mimeType || '').toLowerCase()
  if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(name)) return 'image'
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf'
  if (mime.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm)$/i.test(name)) return 'video'
  if (/合同|contract/i.test(fileName)) return 'contract'
  return 'other'
}

function kindFromPath(relativePath: string): PackageOutputKind {
  if (/\.docx$/i.test(relativePath)) return 'docx'
  if (/\.xlsx$/i.test(relativePath)) return 'xlsx'
  if (/\.pdf$/i.test(relativePath)) return 'pdf'
  if (/\.json$/i.test(relativePath)) return 'json'
  if (/\.zip$/i.test(relativePath)) return 'zip'
  if (/\.txt$/i.test(relativePath)) return 'txt'
  return 'file'
}

function outputDir(packageId: string) {
  return path.join(PACKAGE_OUTPUT_DIR, packageId)
}

export function packageArtifactPath(packageId: string, relativePath: string | null | undefined) {
  const rel = String(relativePath || '').trim()
  if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) return null
  const root = outputDir(packageId)
  const filePath = path.resolve(root, rel)
  if (!filePath.startsWith(root + path.sep)) return null
  return filePath
}

async function loadArtifactData(enterpriseId: string, packageId: string): Promise<BundleData> {
  const pkg = await prisma.standardExecutionPackage.findFirst({
    where: { id: packageId, enterpriseId },
    include: { items: { orderBy: { sortNo: 'asc' } } },
  })
  if (!pkg) throw Object.assign(new Error('审计包不存在'), { status: 404 })

  const recordIds = pkg.items.map((i) => i.recordId)
  const submissionIds = pkg.items.map((i) => i.submissionId)
  const taskIds = pkg.items.map((i) => i.taskId)
  const requirementIds = pkg.items.map((i) => i.requirementId)

  const [enterprise, records, submissions, tasks, requirements, attachments, reviewLogs] = await Promise.all([
    prisma.enterprise.findUnique({ where: { id: enterpriseId }, select: { name: true } }),
    prisma.standardExecutionRecord.findMany({ where: { id: { in: recordIds }, enterpriseId } }),
    prisma.standardExecutionSubmission.findMany({ where: { id: { in: submissionIds }, enterpriseId } }),
    prisma.standardExecutionTask.findMany({ where: { id: { in: taskIds }, enterpriseId } }),
    prisma.standardExecutionRequirement.findMany({
      where: { id: { in: requirementIds }, enterpriseId },
      include: { source: true },
    }),
    prisma.standardExecutionAttachment.findMany({
      where: { enterpriseId, bizType: 'SUBMISSION', bizId: { in: submissionIds } },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.standardExecutionReviewLog.findMany({
      where: { submissionId: { in: submissionIds }, enterpriseId },
      orderBy: { createdAt: 'asc' },
    }),
  ])

  const userIds = new Set<string>()
  for (const submission of submissions) {
    userIds.add(submission.assigneeId)
    if (submission.reviewerId) userIds.add(submission.reviewerId)
  }
  for (const task of tasks) {
    if (task.reviewerId) userIds.add(task.reviewerId)
  }
  for (const attachment of attachments) userIds.add(attachment.uploadedBy)
  for (const log of reviewLogs) userIds.add(log.reviewerId)
  userIds.add(pkg.createdBy)
  const users = userIds.size
    ? await prisma.appUser.findMany({
      where: { id: { in: Array.from(userIds) } },
      select: { id: true, name: true, phone: true },
    })
    : []

  const recordMap = new Map(records.map((r) => [r.id, r]))
  const submissionMap = new Map(submissions.map((s) => [s.id, s]))
  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  const requirementMap = new Map(requirements.map((r) => [r.id, r]))
  const attachmentsBySubmission = new Map<string, typeof attachments>()
  for (const attachment of attachments) {
    const list = attachmentsBySubmission.get(attachment.bizId) || []
    list.push(attachment)
    attachmentsBySubmission.set(attachment.bizId, list)
  }
  const reviewLogsBySubmission = new Map<string, typeof reviewLogs>()
  for (const log of reviewLogs) {
    const list = reviewLogsBySubmission.get(log.submissionId) || []
    list.push(log)
    reviewLogsBySubmission.set(log.submissionId, list)
  }

  const entries: BundleEntry[] = []
  for (const [index, item] of pkg.items.entries()) {
    const record = recordMap.get(item.recordId)
    const submission = submissionMap.get(item.submissionId)
    const task = taskMap.get(item.taskId)
    const fallbackRequirement = requirementMap.get(item.requirementId)
    const basis = task ? resolveRequirementBasis(task.basisSnapshots, item.requirementId, fallbackRequirement) : null
    if (!record || !submission || !task || !basis) continue
    entries.push({
      index,
      item,
      record,
      submission,
      task,
      requirement: {
        ...(basis.requirement as BundleEntry['requirement']),
        requiredMaterials: fallbackRequirement?.requiredMaterials,
      },
      source: basis.source as BundleEntry['source'],
      attachments: attachmentsBySubmission.get(submission.id) || [],
      reviewLogs: reviewLogsBySubmission.get(submission.id) || [],
    })
  }

  return { pkg, enterpriseName: enterprise?.name ?? enterpriseId, entries, userMap: new Map(users.map((u) => [u.id, u])) }
}

function buildAttachmentIndex(data: BundleData): AttachmentIndexRow[] {
  const rows: AttachmentIndexRow[] = []
  for (const entry of data.entries) {
    for (const attachment of entry.attachments) {
      const taskDir = safeSegment(entry.task.id, 'task')
      const relativePath = `证据附件/${taskDir}/${safeSegment(attachment.fileName, attachment.id)}`
      rows.push({
        fileName: attachment.fileName,
        type: attachmentType(attachment.fileName, attachment.mimeType),
        size: attachment.fileSize,
        uploadedBy: userName(data, attachment.uploadedBy),
        uploadedAt: fmtDate(attachment.createdAt),
        taskTitle: entry.task.title,
        recordTitle: entry.record.title,
        relativePath,
      })
    }
  }
  return rows
}

function buildMissingAttachments(data: BundleData): PackagePreview['missingAttachments'] {
  return data.entries
    .filter((entry) => needsAttachment(entry) && entry.attachments.length === 0)
    .map((entry) => ({
      recordId: entry.record.id,
      recordTitle: entry.record.title,
      taskId: entry.task.id,
      taskTitle: entry.task.title,
      reason: '任务要求提交附件，但当前执行记录未检测到附件',
    }))
}

function recordDirectoryName(entry: BundleEntry) {
  const clause = safeSegment(entry.requirement.clauseNo || entry.record.id.slice(0, 8), '控制点')
  return `${String(entry.index + 1).padStart(2, '0')}-${clause}`
}

function buildOutputTree(options: Required<PackageGenerationOptionsInput>, attachmentRows: AttachmentIndexRow[], data: BundleData) {
  const recordFiles = data.entries.flatMap((entry) => {
    const dir = `records/${recordDirectoryName(entry)}`
    return [
      { path: `${dir}/提交内容.pdf`, kind: 'pdf' as const, label: `${entry.record.title}提交内容`, required: true },
      ...entry.attachments.map((attachment) => ({
        path: `${dir}/${safeSegment(attachment.fileName, attachment.id)}`,
        kind: 'file' as const,
        label: attachment.fileName,
        required: true,
      })),
    ]
  })
  const files: PackagePreview['outputFileTree'] = [
    { path: '封面.pdf', kind: 'pdf', label: '封面', required: true },
    { path: '目录.pdf', kind: 'pdf', label: '目录页', required: true },
    ...recordFiles,
    { path: '汇总.pdf', kind: 'pdf', label: '汇总', required: false },
    { path: 'README.txt', kind: 'txt', label: '目录索引', required: true },
    { path: '主报告.docx', kind: 'docx', label: 'Word 主报告', required: true },
    { path: '证据附件索引.xlsx', kind: 'xlsx', label: '证据附件索引表', required: true },
    ...attachmentRows.map((row) => ({
      path: row.relativePath,
      kind: 'file' as const,
      label: row.fileName,
      required: true,
    })),
  ]
  if (options.includeManifest) files.push({ path: 'manifest.json', kind: 'json', label: 'JSON 数据附录', required: false })
  if (options.includeAuditTrace) files.push({ path: '审计追溯表.xlsx', kind: 'xlsx', label: '审计追溯表', required: false })
  if (options.includeBasisClauses) files.push({ path: '依据条款汇编.docx', kind: 'docx', label: '依据条款汇编', required: false })
  if (options.includeStatisticsSummary) files.push({ path: '统计摘要.docx', kind: 'docx', label: '统计摘要', required: false })
  files.push({ path: '全部材料.zip', kind: 'zip', label: '全部材料 ZIP', required: true })
  return files
}

function buildPreviewItems(params: {
  preview: Omit<PackagePreview, 'previewItems'>
  invalidRecordCount: number
}) {
  const { preview, invalidRecordCount } = params
  const hasMissingAttachments = preview.missingAttachments.length > 0
  return [
    { key: 'template', label: '模板场景', status: 'OK' as const, value: preview.package.packageScene },
    { key: 'cover', label: '封面信息', status: 'OK' as const, value: preview.cover.reportTitle },
    { key: 'records', label: '选入记录', status: preview.stats.recordCount > 0 ? 'OK' as const : 'BLOCKED' as const, value: preview.stats.recordCount },
    { key: 'tasks', label: '覆盖任务', status: 'OK' as const, value: preview.stats.taskCount },
    { key: 'requirements', label: '执行要求', status: 'OK' as const, value: preview.stats.requirementCount },
    { key: 'sources', label: '标准来源', status: 'OK' as const, value: preview.stats.sourceCount },
    { key: 'attachments', label: '证据附件', status: hasMissingAttachments ? 'WARN' as const : 'OK' as const, value: preview.stats.attachmentCount },
    { key: 'missingAttachments', label: '缺失附件', status: hasMissingAttachments ? 'WARN' as const : 'OK' as const, value: preview.missingAttachments.length },
    { key: 'traceability', label: '审计追溯', status: preview.v2Options.includeAuditTrace ? 'OK' as const : 'WARN' as const, value: preview.v2Options.includeAuditTrace },
    { key: 'invalidRecordRisk', label: '失效风险', status: invalidRecordCount > 0 ? 'WARN' as const : 'OK' as const, value: invalidRecordCount },
    { key: 'outputs', label: '输出文件', status: 'OK' as const, value: preview.outputFileTree.length },
  ]
}

export async function buildPackagePreview(
  enterpriseId: string,
  packageId: string,
  input?: Partial<PackageGenerationOptionsInput>,
): Promise<PackagePreview> {
  const options = normalizeOptions(input)
  const data = await loadArtifactData(enterpriseId, packageId)
  const attachmentRows = buildAttachmentIndex(data)
  const attachmentCounts = { image: 0, pdf: 0, video: 0, contract: 0, other: 0 }
  for (const row of attachmentRows) attachmentCounts[row.type as keyof typeof attachmentCounts]++
  const sourceIds = new Set(data.entries.map((entry) => entry.source.id || entry.source.title || 'source'))
  const taskIds = new Set(data.entries.map((entry) => entry.task.id))
  const requirementIds = new Set(data.entries.map((entry) => entry.requirement.id))
  const estimatedAttachmentSize = attachmentRows.reduce((sum, row) => sum + (row.size || 0), 0)
  const invalidRecordIds = data.entries.filter((entry) => entry.record.status !== 'VALID').map((entry) => entry.record.id)

  const previewWithoutItems = {
    package: {
      id: data.pkg.id,
      title: data.pkg.title,
      packageScene: data.pkg.packageScene,
      description: data.pkg.description,
      dateFrom: data.pkg.dateFrom?.toISOString() ?? null,
      dateTo: data.pkg.dateTo?.toISOString() ?? null,
    },
    cover: {
      reportTitle: packageReportTitle(data.pkg.title),
      enterpriseName: data.enterpriseName,
      packageSceneLabel: sceneLabel(data.pkg.packageScene),
      auditDateRange: auditDateRange(data.pkg),
      generatedBy: userName(data, data.pkg.createdBy),
      generatedAt: fmtDate(new Date()),
    },
    stats: {
      recordCount: data.entries.length,
      taskCount: taskIds.size,
      requirementCount: requirementIds.size,
      sourceCount: sourceIds.size,
      attachmentCount: attachmentRows.length,
    },
    attachmentCounts,
    missingAttachments: buildMissingAttachments(data),
    bodySections: BODY_SECTIONS,
    outputFileTree: buildOutputTree(options, attachmentRows, data),
    directoryTree: ['封面.pdf', '目录.pdf', 'records/', '汇总.pdf', '主报告.docx', '审计追溯表.xlsx', '证据附件/', 'README.txt', '全部材料.zip'],
    reportStructurePreview: BODY_SECTIONS,
    invalidRecordRisk: {
      hasInvalidRecord: data.pkg.hasInvalidRecord || invalidRecordIds.length > 0,
      invalidRecordCount: invalidRecordIds.length,
      invalidRecordIds,
    },
    attachmentIndexPreview: attachmentRows.slice(0, 20),
    v2Options: options,
    estimatedOutputSize: estimatedAttachmentSize + 256 * 1024,
  }
  return {
    ...previewWithoutItems,
    previewItems: buildPreviewItems({
      preview: previewWithoutItems,
      invalidRecordCount: invalidRecordIds.length,
    }),
  }
}

function buildMainReportMarkdown(data: BundleData, preview: PackagePreview) {
  const lines: string[] = []
  lines.push('# 封面')
  lines.push(`报告标题：${preview.cover.reportTitle}`)
  lines.push(`企业名称：${data.enterpriseName}`)
  lines.push(`使用场景：${preview.cover.packageSceneLabel}`)
  lines.push(`审计时间范围：${preview.cover.auditDateRange}`)
  lines.push(`生成时间：${fmtDate(new Date())}`)
  lines.push('')
  lines.push('# 基本信息')
  lines.push(`审计包名称：${data.pkg.title}`)
  lines.push(`说明：${data.pkg.description || '无'}`)
  lines.push(`选入执行记录：${preview.stats.recordCount} 条`)
  lines.push(`覆盖任务：${preview.stats.taskCount} 个`)
  lines.push(`覆盖执行要求：${preview.stats.requirementCount} 个`)
  lines.push(`覆盖标准来源：${preview.stats.sourceCount} 个`)
  lines.push('')
  lines.push('# 标准依据')
  for (const entry of data.entries) {
    const sourceTitle = entry.source.title || '未知来源'
    const clause = entry.requirement.clauseNo ? `[${entry.requirement.clauseNo}] ` : ''
    lines.push(`- ${sourceTitle}${entry.source.sourceNo ? `（${entry.source.sourceNo}）` : ''}：${clause}${entry.requirement.title || '未命名执行要求'}`)
  }
  lines.push('')
  lines.push('# 任务汇总')
  for (const entry of data.entries) {
    lines.push(`- ${entry.task.title}：${entry.submission.status}，截止 ${fmtDate(entry.task.deadlineAt)}`)
  }
  lines.push('')
  lines.push('# 记录明细')
  for (const entry of data.entries) {
    lines.push(`## ${entry.index + 1}. ${entry.record.title}`)
    lines.push(`- 任务：${entry.task.title}`)
    lines.push(`- 提交人：${userName(data, entry.submission.assigneeId)}`)
    lines.push(`- 提交时间：${fmtDate(entry.submission.submittedAt)}`)
    lines.push(`- 提交内容：${entry.submission.submitText || '无'}`)
    if (entry.submission.reviewComment) lines.push(`- 审核意见：${entry.submission.reviewComment}`)
  }
  lines.push('')
  lines.push('# 证据清单')
  if (preview.attachmentIndexPreview.length === 0) {
    lines.push('暂无证据附件。')
  } else {
    for (const row of buildAttachmentIndex(data)) {
      lines.push(`- ${row.fileName}（${row.type}）：${row.recordTitle} / ${row.taskTitle}`)
    }
  }
  if (preview.missingAttachments.length > 0) {
    lines.push('')
    lines.push('缺失附件提醒：')
    for (const missing of preview.missingAttachments) {
      lines.push(`- ${missing.recordTitle} / ${missing.taskTitle}：${missing.reason}`)
    }
  }
  lines.push('')
  lines.push('# 审核与生成信息')
  for (const entry of data.entries) {
    for (const log of entry.reviewLogs) {
      lines.push(`- ${entry.record.title}：${reviewActionLabel(log.action)}，审核人 ${userName(data, log.reviewerId)}，${fmtDate(log.createdAt)}${log.comment ? `，意见：${log.comment}` : ''}`)
    }
  }
  if (data.entries.every((entry) => entry.reviewLogs.length === 0)) lines.push('暂无审核日志。')
  return lines.join('\n')
}

function buildCoverLines(data: BundleData, preview: PackagePreview) {
  return [
    `企业名称：${data.enterpriseName}`,
    `审计场景：${preview.cover.packageSceneLabel}`,
    `审计时间范围：${preview.cover.auditDateRange}`,
    `审计包标题：${data.pkg.title}`,
    `生成人：${preview.cover.generatedBy}`,
    `生成时间：${preview.cover.generatedAt}`,
    `总计记录数：${preview.stats.recordCount}`,
    `涉及控制点数：${preview.stats.requirementCount}`,
    `涉及标准数：${preview.stats.sourceCount}`,
    data.pkg.hasInvalidRecord || preview.invalidRecordRisk.hasInvalidRecord
      ? '警告：该审计包包含已作废或失效记录，请重新生成或复核后使用。'
      : '记录状态：当前未检测到失效记录。',
    '',
    '备注说明：',
    data.pkg.description || '无',
  ]
}

function buildDirectoryLines(data: BundleData) {
  const lines: string[] = []
  const grouped = new Map<string, Map<string, Map<string, BundleEntry[]>>>()
  for (const entry of data.entries) {
    const source = `${entry.source.sourceNo ? `${entry.source.sourceNo} ` : ''}${entry.source.title || '未知标准'}`
    const requirement = `${entry.requirement.clauseNo ? `[${entry.requirement.clauseNo}] ` : ''}${entry.requirement.title || '未命名控制点'}`
    const task = entry.task.title
    if (!grouped.has(source)) grouped.set(source, new Map())
    const byReq = grouped.get(source)!
    if (!byReq.has(requirement)) byReq.set(requirement, new Map())
    const byTask = byReq.get(requirement)!
    const entries = byTask.get(task) ?? []
    entries.push(entry)
    byTask.set(task, entries)
  }

  let index = 1
  for (const [source, byReq] of grouped) {
    lines.push(`## ${source}`)
    for (const [requirement, byTask] of byReq) {
      lines.push(`  ${requirement}`)
      for (const [task, entries] of byTask) {
        lines.push(`    ${task}`)
        for (const entry of entries) {
          lines.push(`      ${index}. 执行人：${userName(data, entry.submission.assigneeId)}｜记录：${entry.record.title}｜目录：records/${recordDirectoryName(entry)}/`)
          index++
        }
      }
    }
    lines.push('')
  }
  return lines.length ? lines : ['暂无目录项']
}

function buildSubmissionLines(data: BundleData, entry: BundleEntry) {
  return [
    `记录标题：${entry.record.title}`,
    `控制点：${entry.requirement.clauseNo ? `[${entry.requirement.clauseNo}] ` : ''}${entry.requirement.title || '未命名控制点'}`,
    `任务：${entry.task.title}`,
    `提交人：${userName(data, entry.submission.assigneeId)}`,
    `提交时间：${fmtDate(entry.submission.submittedAt)}`,
    `审核人：${userName(data, entry.submission.reviewerId || entry.task.reviewerId)}`,
    `审核时间：${fmtDate(entry.submission.reviewedAt)}`,
    `审核意见：${entry.submission.reviewComment || '无'}`,
    '',
    '## 提交内容',
    entry.submission.submitText || '无',
    '',
    '## 结构化提交数据',
    entry.submission.submitDataJson ? JSON.stringify(entry.submission.submitDataJson, null, 2) : '无',
  ]
}

function buildSummaryLines(data: BundleData, preview: PackagePreview) {
  const lines = [
    `企业名称：${data.enterpriseName}`,
    `审计场景：${preview.cover.packageSceneLabel}`,
    `审计时间范围：${preview.cover.auditDateRange}`,
    `总计记录数：${preview.stats.recordCount}`,
    `涉及控制点数：${preview.stats.requirementCount}`,
    `涉及标准数：${preview.stats.sourceCount}`,
    '',
  ]
  for (const entry of data.entries) {
    lines.push(`## ${entry.index + 1}. ${entry.record.title}`)
    lines.push(`控制点：${entry.requirement.clauseNo ? `[${entry.requirement.clauseNo}] ` : ''}${entry.requirement.title || '未命名控制点'}`)
    lines.push(`任务：${entry.task.title}`)
    lines.push(`执行人：${userName(data, entry.submission.assigneeId)}`)
    lines.push(`提交摘要：${entry.submission.submitText || '无'}`)
    lines.push('')
  }
  return lines
}

function buildBasisClausesMarkdown(data: BundleData) {
  const lines = ['# 依据条款汇编', '']
  for (const entry of data.entries) {
    const clause = entry.requirement.clauseNo ? `[${entry.requirement.clauseNo}] ` : ''
    lines.push(`## ${clause}${entry.requirement.title || '未命名执行要求'}`)
    lines.push(`来源：${entry.source.title || '未知来源'}${entry.source.sourceNo ? `（${entry.source.sourceNo}）` : ''}`)
    lines.push(entry.requirement.requirementText || '暂无条款原文。')
    lines.push('')
  }
  return lines.join('\n')
}

function buildStatisticsMarkdown(data: BundleData, preview: PackagePreview) {
  const approved = data.entries.filter((entry) => entry.submission.status === 'APPROVED').length
  const onTime = data.entries.filter((entry) => entry.task.deadlineAt && entry.submission.submittedAt.getTime() <= entry.task.deadlineAt.getTime()).length
  const rejected = data.entries.filter((entry) => entry.reviewLogs.some((log) => log.action === 'REJECT')).length
  const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : '-')
  return [
    '# 统计摘要',
    '',
    `- 完成率：${pct(approved, preview.stats.recordCount)}（${approved}/${preview.stats.recordCount}）`,
    `- 按时率：${pct(onTime, preview.stats.recordCount)}（${onTime}/${preview.stats.recordCount}）`,
    `- 整改率：${pct(rejected, preview.stats.recordCount)}（${rejected}/${preview.stats.recordCount}）`,
    '',
    '按标准来源统计：',
    ...Array.from(new Set(data.entries.map((entry) => entry.source.title || '未知来源'))).map((source) => {
      const count = data.entries.filter((entry) => (entry.source.title || '未知来源') === source).length
      return `- ${source}：${count} 条执行记录`
    }),
  ].join('\n')
}

async function writeDocx(filePath: string, title: string, markdown: string) {
  const doc = new Document({
    creator: '标准小智',
    title,
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          alignment: AlignmentType.CENTER,
          heading: HeadingLevel.TITLE,
          children: [new TextRun({ text: title, bold: true })],
        }),
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: `生成时间：${fmtDate(new Date())}`, italics: true })],
        }),
        new Paragraph({ children: [new TextRun({ text: '' })] }),
        ...markdownToParagraphs(markdown),
      ],
    }],
  })
  const buf = await Packer.toBuffer(doc)
  await writeFile(filePath, buf as unknown as Uint8Array)
}

async function writeXlsx(filePath: string, sheetName: string, rows: Array<Record<string, unknown>>) {
  const ws = XLSX.utils.json_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  await writeFile(filePath, buf)
}

function buildReadme(data: BundleData, preview: PackagePreview) {
  return [
    `审计包：${data.pkg.title}`,
    `生成时间：${fmtDate(new Date())}`,
    '',
    '包内结构：',
    '- 封面.pdf：企业、审计场景、时间范围和统计信息',
    '- 目录.pdf：按标准来源 → 控制点 → 任务 → 执行人分级目录',
    '- records/<序号-控制点编号>/提交内容.pdf：单条记录提交内容与结构化数据',
    '- records/<序号-控制点编号>/：该记录附件原件',
    '- 汇总.pdf：封面、目录和所有提交摘要',
    '- README.txt：目录索引与统计',
    '- 主报告.docx：7 段结构主报告',
    '- 证据附件索引.xlsx：证据附件索引表',
    '- 证据附件/<任务ID>/：证据附件原文件',
    '- manifest.json：JSON 数据附录（勾选后生成）',
    '- 审计追溯表.xlsx：标准来源到审核记录链路（勾选后生成）',
    '- 依据条款汇编.docx：涉及条款节选（勾选后生成）',
    '- 统计摘要.docx：完成率、按时率、整改率摘要（勾选后生成）',
    '',
    '统计：',
    `- 执行记录：${preview.stats.recordCount}`,
    `- 覆盖任务：${preview.stats.taskCount}`,
    `- 覆盖执行要求：${preview.stats.requirementCount}`,
    `- 标准来源：${preview.stats.sourceCount}`,
    `- 证据附件：${preview.stats.attachmentCount}`,
    `- 缺失附件提醒：${preview.missingAttachments.length}`,
    preview.invalidRecordRisk.hasInvalidRecord ? '- 警告：包含已作废或失效记录，请复核后使用' : '- 失效记录：未检测到',
  ].join('\n')
}

function buildAuditRows(data: BundleData): AuditTraceRow[] {
  return data.entries.map((entry) => ({
    source: entry.source.title || '未知来源',
    requirement: `${entry.requirement.clauseNo ? `[${entry.requirement.clauseNo}] ` : ''}${entry.requirement.title || '未命名执行要求'}`,
    task: entry.task.title,
    submitter: userName(data, entry.submission.assigneeId),
    reviewer: userName(data, entry.submission.reviewerId || entry.task.reviewerId),
    submittedAt: fmtDate(entry.submission.submittedAt),
    reviewedAt: fmtDate(entry.submission.reviewedAt),
    files: entry.attachments.map((attachment) => attachment.fileName).join('；') || '-',
  }))
}

function fileSizeOrZero(filePath: string) {
  return stat(filePath).then((s) => s.size).catch(() => 0)
}

async function addOutput(outputs: PackageOutputFile[], root: string, relativePath: string, label: string, required: boolean) {
  const size = await fileSizeOrZero(path.join(root, relativePath))
  outputs.push({ path: relativePath, kind: kindFromPath(relativePath), label, size, required })
}

async function addDirToZip(zip: JSZip, root: string, currentDir = '') {
  const entries = await readdir(path.join(root, currentDir), { withFileTypes: true })
  for (const entry of entries) {
    const relativePath = currentDir ? `${currentDir}/${entry.name}` : entry.name
    if (relativePath === '全部材料.zip') continue
    if (entry.isDirectory()) {
      await addDirToZip(zip, root, relativePath)
    } else if (entry.isFile()) {
      zip.file(relativePath, await readFile(path.join(root, relativePath)))
    }
  }
}

async function writeZipBundle(root: string) {
  const zip = new JSZip()
  await addDirToZip(zip, root)
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await writeFile(path.join(root, '全部材料.zip'), buf)
}

export async function generatePackageArtifacts(
  enterpriseId: string,
  packageId: string,
  input?: Partial<PackageGenerationOptionsInput>,
) {
  const options = normalizeOptions(input)
  const data = await loadArtifactData(enterpriseId, packageId)
  const preview = await buildPackagePreview(enterpriseId, packageId, options)
  const root = outputDir(packageId)
  await rm(root, { recursive: true, force: true })
  await mkdir(path.join(root, '证据附件'), { recursive: true })
  await mkdir(path.join(root, 'records'), { recursive: true })

  const outputs: PackageOutputFile[] = []
  await writePdf(path.join(root, '封面.pdf'), '封面信息', buildCoverLines(data, preview))
  await addOutput(outputs, root, '封面.pdf', '封面', true)

  await writePdf(path.join(root, '目录.pdf'), '目录页', buildDirectoryLines(data))
  await addOutput(outputs, root, '目录.pdf', '目录页', true)

  await writePdf(path.join(root, '汇总.pdf'), '汇总', buildSummaryLines(data, preview))
  await addOutput(outputs, root, '汇总.pdf', '汇总', false)

  await writeFile(path.join(root, 'README.txt'), buildReadme(data, preview))
  await addOutput(outputs, root, 'README.txt', '目录索引', true)

  await writeDocx(path.join(root, '主报告.docx'), `${packageReportTitle(data.pkg.title)}主报告`, buildMainReportMarkdown(data, preview))
  await addOutput(outputs, root, '主报告.docx', 'Word 主报告', true)

  const attachmentRows = buildAttachmentIndex(data)
  await writeXlsx(path.join(root, '证据附件索引.xlsx'), '证据附件索引', attachmentRows.map((row) => ({
    fileName: row.fileName,
    类型: row.type,
    大小: row.size ?? '',
    上传人: row.uploadedBy,
    时间: row.uploadedAt,
    关联任务: row.taskTitle,
    关联记录: row.recordTitle,
  })))
  await addOutput(outputs, root, '证据附件索引.xlsx', '证据附件索引表', true)

  const skippedAttachments: Array<{ fileName: string; fileUrl: string; reason: string }> = []
  const usedNamesByTask = new Map<string, Set<string>>()
  const usedNamesByRecordDir = new Map<string, Set<string>>()
  for (const entry of data.entries) {
    const taskDir = safeSegment(entry.task.id, 'task')
    const recordDir = recordDirectoryName(entry)
    await mkdir(path.join(root, '证据附件', taskDir), { recursive: true })
    await mkdir(path.join(root, 'records', recordDir), { recursive: true })
    const submissionPdfPath = `records/${recordDir}/提交内容.pdf`
    await writePdf(path.join(root, submissionPdfPath), `${entry.record.title}提交内容`, buildSubmissionLines(data, entry))
    await addOutput(outputs, root, submissionPdfPath, `${entry.record.title}提交内容`, true)

    const usedNames = usedNamesByTask.get(taskDir) || new Set<string>()
    usedNamesByTask.set(taskDir, usedNames)
    const usedRecordNames = usedNamesByRecordDir.get(recordDir) || new Set<string>()
    usedNamesByRecordDir.set(recordDir, usedRecordNames)
    for (const attachment of entry.attachments) {
      const localPath = localUploadPath(attachment.fileUrl)
      if (!localPath || !existsSync(localPath)) {
        skippedAttachments.push({
          fileName: attachment.fileName,
          fileUrl: attachment.fileUrl,
          reason: localPath ? 'LOCAL_FILE_MISSING' : 'NON_LOCAL_URL',
        })
        continue
      }
      const base = safeSegment(attachment.fileName, path.basename(localPath))
      const ext = path.extname(base)
      const stem = ext ? base.slice(0, -ext.length) : base
      let finalName = base
      let seq = 1
      while (usedNames.has(finalName)) {
        finalName = `${stem}_${seq}${ext}`
        seq++
      }
      usedNames.add(finalName)
      const relativePath = `证据附件/${taskDir}/${finalName}`
      await copyFile(localPath, path.join(root, relativePath))
      await addOutput(outputs, root, relativePath, attachment.fileName, true)

      let recordFinalName = base
      let recordSeq = 1
      while (usedRecordNames.has(recordFinalName)) {
        recordFinalName = `${stem}_${recordSeq}${ext}`
        recordSeq++
      }
      usedRecordNames.add(recordFinalName)
      const recordRelativePath = `records/${recordDir}/${recordFinalName}`
      await copyFile(localPath, path.join(root, recordRelativePath))
      await addOutput(outputs, root, recordRelativePath, attachment.fileName, true)
    }
  }

  const manifest = {
    package: preview.package,
    generatedAt: new Date().toISOString(),
    options,
    stats: preview.stats,
    attachmentCounts: preview.attachmentCounts,
    missingAttachments: preview.missingAttachments,
    skippedAttachments,
    files: outputs,
    records: data.entries.map((entry) => ({
      recordId: entry.record.id,
      recordTitle: entry.record.title,
      taskId: entry.task.id,
      taskTitle: entry.task.title,
      requirementId: entry.requirement.id,
      requirementTitle: entry.requirement.title,
      sourceTitle: entry.source.title,
      submissionId: entry.submission.id,
    })),
  }

  if (options.includeManifest) {
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2))
    await addOutput(outputs, root, 'manifest.json', 'JSON 数据附录', false)
  }
  if (options.includeAuditTrace) {
    await writeXlsx(path.join(root, '审计追溯表.xlsx'), '审计追溯', buildAuditRows(data).map((row) => ({
      标准来源: row.source,
      执行要求: row.requirement,
      任务: row.task,
      提交人: row.submitter,
      审核人: row.reviewer,
      提交时间: row.submittedAt,
      审核时间: row.reviewedAt,
      关联文件: row.files,
    })))
    await addOutput(outputs, root, '审计追溯表.xlsx', '审计追溯表', false)
  }
  if (options.includeBasisClauses) {
    await writeDocx(path.join(root, '依据条款汇编.docx'), `${data.pkg.title}依据条款汇编`, buildBasisClausesMarkdown(data))
    await addOutput(outputs, root, '依据条款汇编.docx', '依据条款汇编', false)
  }
  if (options.includeStatisticsSummary) {
    await writeDocx(path.join(root, '统计摘要.docx'), `${data.pkg.title}统计摘要`, buildStatisticsMarkdown(data, preview))
    await addOutput(outputs, root, '统计摘要.docx', '统计摘要', false)
  }
  await writeZipBundle(root)
  await addOutput(outputs, root, '全部材料.zip', '全部材料 ZIP', true)

  return {
    batchId: `se_pkg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    outputDir: root,
    fileUrl: `/uploads/se-packages/${packageId}/README.txt`,
    preview,
    outputManifest: { ...manifest, files: outputs },
    outputFiles: outputs,
    skippedAttachments,
  }
}

export async function readPackageArtifactFile(
  enterpriseId: string,
  packageId: string,
  relativePath: string | null | undefined,
) {
  const pkg = await prisma.standardExecutionPackage.findFirst({
    where: { id: packageId, enterpriseId },
    select: { id: true, status: true },
  })
  if (!pkg) throw Object.assign(new Error('记录不存在'), { status: 404 })
  if (pkg.status !== 'READY') throw Object.assign(new Error('审计包尚未生成'), { status: 409 })
  const filePath = packageArtifactPath(packageId, relativePath)
  if (!filePath) throw Object.assign(new Error('审计包文件地址非法'), { status: 400 })
  if (!existsSync(filePath)) throw Object.assign(new Error('审计包文件不存在，请重新生成'), { status: 404 })
  return {
    filePath,
    downloadName: path.basename(filePath),
    content: await readFile(filePath),
  }
}

export async function packageZipDownloadName(enterpriseId: string, packageId: string) {
  const data = await loadArtifactData(enterpriseId, packageId)
  const range = auditDateRange(data.pkg).replace(/\s+/g, '')
  return `${safeSegment(data.enterpriseName, '企业')}-${safeSegment(sceneLabel(data.pkg.packageScene), '审计场景')}-${safeSegment(range, '未设置')}-审计包.zip`
}
