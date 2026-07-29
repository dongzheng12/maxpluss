import { existsSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import JSZip from 'jszip'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { prisma } from '../db.js'
import { buildStdFrameworkDocx } from '../services/stdFrameworkDocx.js'
import type { PackageFormat } from './enums.js'
import { resolveRequirementBasis } from './basisSnapshots.js'

export const PACKAGE_OUTPUT_DIR = path.resolve(
  process.env.SE_PACKAGE_OUTPUT_DIR || path.join(process.cwd(), 'uploads', 'se-packages'),
)

function safeSegment(input: unknown, fallback: string) {
  const s = String(input || fallback)
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
  return s || fallback
}

function localUploadPath(fileUrl: string) {
  if (!fileUrl.startsWith('/uploads/')) return null
  const uploadsRoot = path.resolve(process.cwd(), 'uploads')
  const filePath = path.resolve(process.cwd(), `.${fileUrl}`)
  if (!filePath.startsWith(uploadsRoot + path.sep)) return null
  return filePath
}

export function packageFilePathFromUrl(fileUrl: string | null | undefined) {
  if (!fileUrl) return null
  const prefix = '/uploads/se-packages/'
  if (!fileUrl.startsWith(prefix)) return null
  return path.join(PACKAGE_OUTPUT_DIR, path.basename(fileUrl))
}

async function loadBundleData(enterpriseId: string, packageId: string) {
  const pkg = await prisma.standardExecutionPackage.findFirst({
    where: { id: packageId, enterpriseId },
    include: { items: { orderBy: { sortNo: 'asc' } } },
  })
  if (!pkg) throw Object.assign(new Error('审计包不存在'), { status: 404 })

  const recordIds = pkg.items.map((i) => i.recordId)
  const submissionIds = pkg.items.map((i) => i.submissionId)
  const taskIds = pkg.items.map((i) => i.taskId)
  const requirementIds = pkg.items.map((i) => i.requirementId)

  const [records, submissions, tasks, requirements, attachments, reviewLogs] = await Promise.all([
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

  return { pkg, recordMap, submissionMap, taskMap, requirementMap, attachmentsBySubmission, reviewLogsBySubmission }
}

function buildBundleMarkdown(data: Awaited<ReturnType<typeof loadBundleData>>) {
  const lines: string[] = [
    `# ${data.pkg.title}`,
    '',
    `- 使用场景：${data.pkg.packageScene}`,
    `- 生成时间：${new Date().toISOString()}`,
    `- 记录数量：${data.pkg.items.length}`,
    '',
  ]

  data.pkg.items.forEach((item, idx) => {
    const record = data.recordMap.get(item.recordId)
    const submission = data.submissionMap.get(item.submissionId)
    const task = data.taskMap.get(item.taskId)
    const basis = task ? resolveRequirementBasis(task.basisSnapshots, item.requirementId, data.requirementMap.get(item.requirementId)) : null
    if (!record || !submission || !task || !basis) return
    const attachments = data.attachmentsBySubmission.get(submission.id) || []
    const logs = data.reviewLogsBySubmission.get(submission.id) || []
    const requirement = basis.requirement as { clauseNo?: string | null; title?: string | null }
    const source = basis.source as { title?: string; sourceNo?: string | null }

    lines.push(`## ${idx + 1}. ${record.title}`)
    lines.push(`- 标准来源：${source?.title || '未知来源'}${source?.sourceNo ? `（${source.sourceNo}）` : ''}`)
    lines.push(`- 检查点：${requirement.clauseNo ? `[${requirement.clauseNo}] ` : ''}${requirement.title}`)
    lines.push(`- 任务：${task.title}`)
    lines.push(`- 记录状态：${record.status}`)
    lines.push(`- 提交人：${submission.assigneeId}`)
    lines.push(`- 提交内容：${submission.submitText || '无'}`)
    if (logs.length > 0) {
      lines.push('- 审核日志：')
      for (const log of logs) {
        lines.push(`  - ${log.action} ${log.createdAt.toISOString()}${log.comment ? `：${log.comment}` : ''}`)
      }
    }
    if (attachments.length > 0) {
      lines.push('- 附件：')
      for (const attachment of attachments) {
        lines.push(`  - ${attachment.fileName}: ${attachment.fileUrl}`)
      }
    }
    lines.push('')
  })

  return lines.join('\n')
}

function outputPath(packageId: string, ext: 'zip' | 'pdf' | 'docx') {
  const fileName = `${packageId}.${ext}`
  return {
    fileName,
    filePath: path.join(PACKAGE_OUTPUT_DIR, fileName),
    fileUrl: `/uploads/se-packages/${fileName}`,
  }
}

export async function generatePackageZip(enterpriseId: string, packageId: string) {
  const pkg = await prisma.standardExecutionPackage.findFirst({
    where: { id: packageId, enterpriseId },
    include: { items: { orderBy: { sortNo: 'asc' } } },
  })
  if (!pkg) throw Object.assign(new Error('审计包不存在'), { status: 404 })

  const recordIds = pkg.items.map((i) => i.recordId)
  const submissionIds = pkg.items.map((i) => i.submissionId)
  const taskIds = pkg.items.map((i) => i.taskId)
  const requirementIds = pkg.items.map((i) => i.requirementId)

  const [records, submissions, tasks, requirements, attachments, reviewLogs] = await Promise.all([
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

  const zip = new JSZip()
  const skippedAttachments: Array<{ fileName: string; fileUrl: string; reason: string }> = []
  const manifest: unknown[] = []

  zip.file('README.txt', [
    `审计包：${pkg.title}`,
    `场景：${pkg.packageScene}`,
    `生成时间：${new Date().toISOString()}`,
    `记录数量：${pkg.items.length}`,
    '',
    '目录结构：<标准来源>/<检查点>/<记录ID>/record.json + attachments/',
  ].join('\n'))

  for (const item of pkg.items) {
    const record = recordMap.get(item.recordId)
    const submission = submissionMap.get(item.submissionId)
    const task = taskMap.get(item.taskId)
    const basis = task ? resolveRequirementBasis(task.basisSnapshots, item.requirementId, requirementMap.get(item.requirementId)) : null
    if (!record || !submission || !task || !basis) continue

    const requirement = basis.requirement as {
      id: string
      clauseNo?: string | null
      title?: string | null
      source?: unknown
    }
    const source = basis.source as { id?: string; sourceNo?: string | null; title?: string | null }
    const sourceDir = safeSegment([source?.sourceNo, source?.title].filter(Boolean).join('_'), source?.id || 'source')
    const requirementDir = safeSegment([requirement.clauseNo, requirement.title].filter(Boolean).join('_'), requirement.id)
    const recordDir = `${sourceDir}/${requirementDir}/${safeSegment(record.id, 'record')}`
    const folder = zip.folder(recordDir)!
    const itemAttachments = attachmentsBySubmission.get(submission.id) || []
    const itemReviewLogs = reviewLogsBySubmission.get(submission.id) || []

    const recordJson = {
      packageItem: item,
      source,
      requirement,
      task,
      submission,
      record,
      reviewLogs: itemReviewLogs,
      attachments: itemAttachments,
    }
    folder.file('record.json', JSON.stringify(recordJson, null, 2))
    manifest.push({
      recordId: record.id,
      source: source?.title || '未知来源',
      requirement: requirement.title,
      task: task.title,
      submissionId: submission.id,
      attachmentCount: itemAttachments.length,
    })

    const attachmentFolder = folder.folder('attachments')!
    const remoteLinks: string[] = []
    for (const attachment of itemAttachments) {
      const localPath = localUploadPath(attachment.fileUrl)
      if (localPath && existsSync(localPath)) {
        const content = await readFile(localPath)
        attachmentFolder.file(safeSegment(attachment.fileName, path.basename(localPath)), content)
      } else {
        remoteLinks.push(`${attachment.fileName}: ${attachment.fileUrl}`)
        skippedAttachments.push({
          fileName: attachment.fileName,
          fileUrl: attachment.fileUrl,
          reason: localPath ? 'LOCAL_FILE_MISSING' : 'NON_LOCAL_URL',
        })
      }
    }
    if (remoteLinks.length > 0) {
      attachmentFolder.file('attachment-links.txt', remoteLinks.join('\n'))
    }
  }

  zip.file('manifest.json', JSON.stringify({ package: pkg, items: manifest, skippedAttachments }, null, 2))
  await mkdir(PACKAGE_OUTPUT_DIR, { recursive: true })
  const { filePath, fileUrl } = outputPath(packageId, 'zip')
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await writeFile(filePath, buf)

  return {
    fileUrl,
    filePath,
    skippedAttachments,
  }
}

export async function generatePackageDocx(enterpriseId: string, packageId: string) {
  const data = await loadBundleData(enterpriseId, packageId)
  await mkdir(PACKAGE_OUTPUT_DIR, { recursive: true })
  const { filePath, fileUrl } = outputPath(packageId, 'docx')
  const buf = await buildStdFrameworkDocx({
    title: data.pkg.title,
    content: buildBundleMarkdown(data),
    generatedAt: new Date(),
  })
  await writeFile(filePath, buf)
  return { fileUrl, filePath, skippedAttachments: [] as Array<{ fileName: string; fileUrl: string; reason: string }> }
}

// 字体决策（2026-06-01，中文 PDF 验证踩坑后定）：
//  - 不用 DroidSansFallback：纯 CJK 表意字体，hasGlyphForCodePoint 实测对 A/a/数字/英文标点全 NO，
//    单字体嵌入会让条款号/日期/金额等数字与英文全变方框，且 embedFont 成功 → fail-fast 不触发 = 静默坏 PDF。
//  - 不用 fonts-noto-cjk 的 .ttc：collection，fontkit.create() 返回 wrapper（无 layout），需取 .fonts[0]，易踩坑。
//  - 选 NotoSansSC-Regular.otf：单文件 CFF/OpenType，CJK+Latin+数字+标点全覆盖（fontkit 全 YES），
//    SIL OFL 1.1 商用许可，vendoring 进 services/api/assets/fonts/ 并 COPY 进镜像（见 Dockerfile/Dockerfile.prod）。
const PDF_FONT_CANDIDATES = [
  '/app/assets/fonts/NotoSansSC-Regular.otf',          // 容器：prod + dev 镜像 WORKDIR /app
  'assets/fonts/NotoSansSC-Regular.otf',               // 本地开发：cwd=services/api（vitest/tsx）
  'services/api/assets/fonts/NotoSansSC-Regular.otf',  // 本地：从仓库根目录启动
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf', // macOS 系统兜底
]

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

export async function generatePackagePdf(enterpriseId: string, packageId: string) {
  const data = await loadBundleData(enterpriseId, packageId)
  await mkdir(PACKAGE_OUTPUT_DIR, { recursive: true })
  const { filePath, fileUrl } = outputPath(packageId, 'pdf')
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
      // Fall back to Helvetica below.
    }
  }
  const markdown = buildBundleMarkdown(data)
  if (!hasCustomFont && hasNonAscii(`${data.pkg.title}\n${markdown}`)) {
    throw Object.assign(new Error('PDF_CJK_FONT_MISSING'), { status: 500 })
  }

  const pageWidth = 595.28
  const pageHeight = 841.89
  const margin = 48
  const fontSize = 11
  const lineHeight = 17
  let page = pdf.addPage([pageWidth, pageHeight])
  let y = pageHeight - margin

  const draw = (raw: string, size = fontSize, color = rgb(0.12, 0.12, 0.12)) => {
    const text = hasCustomFont ? raw : sanitizeForStandardFont(raw)
    for (const wrapped of wrapLine(text, size > fontSize ? 32 : 56)) {
      if (y < margin) {
        page = pdf.addPage([pageWidth, pageHeight])
        y = pageHeight - margin
      }
      page.drawText(wrapped || ' ', { x: margin, y, size, font, color })
      y -= lineHeight
    }
  }

  draw(data.pkg.title, 18, rgb(0.05, 0.18, 0.32))
  y -= 8
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('# ')) continue
    if (line.startsWith('## ')) {
      y -= 6
      draw(line.replace(/^##\s+/, ''), 13, rgb(0.05, 0.18, 0.32))
    } else {
      draw(line)
    }
  }

  await writeFile(filePath, Buffer.from(await pdf.save()))
  return { fileUrl, filePath, skippedAttachments: [] as Array<{ fileName: string; fileUrl: string; reason: string }> }
}

export async function generatePackageFile(
  enterpriseId: string,
  packageId: string,
  format: PackageFormat,
) {
  if (format === 'PDF') return generatePackagePdf(enterpriseId, packageId)
  if (format === 'DOCX') return generatePackageDocx(enterpriseId, packageId)
  return generatePackageZip(enterpriseId, packageId)
}
