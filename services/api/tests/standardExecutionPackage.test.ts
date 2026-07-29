/**
 * standard-execution / Package list/create/get(树状)/generate/void 测试
 *
 * 覆盖：
 *  - list: 默认 + status / packageScene / keyword + 分页 + enterpriseId 隔离
 *  - create: happy + recordIds 校验（不存在/VOID/跨企业/重复/空）+ 自动 sortNo + DRAFT 状态
 *  - get 树状：source→requirement[]→task[]→submission[]→reviewLogs[]+attachments[] 完整结构
 *  - generate: DRAFT → READY / READY → READY（重新生成版本，doc §五.6）/ VOID → 409
 *  - void: DRAFT/READY → VOID / VOID 重复 noop
 *  - 权限 + 404
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import JSZip from 'jszip'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { createUser, getTestToken } from './factory.js'
import { __resetPackageGenerationJobsForTest } from '../src/standard-execution/packageJobs.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
  __resetPackageGenerationJobsForTest()
})

async function makeAdminToken() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

async function makeRecord(adminId: string, opts: {
  enterpriseId?: string
  recordStatus?: 'VALID' | 'VOID' | 'EXPIRED'
  taskType?: string
  submitRequirement?: string
  requiredMaterials?: unknown
  departmentId?: string | null
  recordDate?: Date
} = {}) {
  const enterpriseId = opts.enterpriseId ?? 'DEFAULT'
  const user = await createUser({ role: 'user' })
  const src = await prisma.standardExecutionSource.create({
    data: { enterpriseId, title: 's', sourceType: 'PRODUCT_STANDARD', createdBy: adminId },
  })
  const req = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId: src.id,
      title: 'r',
      requirementText: 'x',
      status: 'ACTIVE',
      requiredMaterials: opts.requiredMaterials === undefined ? undefined : opts.requiredMaterials as never,
      createdBy: adminId,
    },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId,
      requirementId: req.id,
      title: 't',
      taskType: opts.taskType ?? null,
      submitRequirement: opts.submitRequirement ?? 'x',
      deadlineAt: new Date(Date.now() + 86400000),
      reviewerId: adminId,
      status: 'PUBLISHED',
      createdBy: adminId,
    },
  })
  const sub = await prisma.standardExecutionSubmission.create({
    data: { enterpriseId, taskId: task.id, assigneeId: user.id, submitText: 'submit body', status: 'APPROVED', version: 1, isLatest: true },
  })
  const rec = await prisma.standardExecutionRecord.create({
    data: {
      enterpriseId,
      sourceId: src.id,
      requirementId: req.id,
      taskId: task.id,
      submissionId: sub.id,
      assigneeId: user.id,
      departmentId: opts.departmentId ?? null,
      title: 'rec title',
      status: opts.recordStatus ?? 'VALID',
      ...(opts.recordDate ? { recordDate: opts.recordDate } : {}),
    },
  })
  return { user, src, req, task, sub, rec }
}

function binaryParser(res: NodeJS.ReadableStream, cb: (err: Error | null, body?: Buffer) => void) {
  const chunks: Buffer[] = []
  res.on('data', (chunk) => chunks.push(chunk as Buffer))
  res.on('end', () => cb(null, Buffer.concat(chunks)))
}

describe('POST /packages', () => {
  it('happy — 创建 DRAFT + 批量 PackageItem + sortNo 顺序', async () => {
    const { admin, token } = await makeAdminToken()
    const r1 = await makeRecord(admin.id)
    const r2 = await makeRecord(admin.id)
    const r = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: '客户审核包',
        packageScene: 'CUSTOMER_AUDIT',
        description: '客户年度审厂范围说明',
        dateFrom: '2026-06-01T00:00:00.000Z',
        dateTo: '2026-06-30T23:59:59.000Z',
        recordIds: [r1.rec.id, r2.rec.id],
      })
    expect(r.status).toBe(201)
    expect(r.body.data.status).toBe('DRAFT')
    expect(r.body.data.enterpriseId).toBe('DEFAULT')
    expect(r.body.data.description).toBe('客户年度审厂范围说明')
    expect(new Date(r.body.data.dateFrom).toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(new Date(r.body.data.dateTo).toISOString()).toBe('2026-06-30T23:59:59.000Z')

    const items = await prisma.standardExecutionPackageItem.findMany({
      where: { packageId: r.body.data.id },
      orderBy: { sortNo: 'asc' },
    })
    expect(items.length).toBe(2)
    expect(items[0].recordId).toBe(r1.rec.id)
    expect(items[1].recordId).toBe(r2.rec.id)
    expect(items[0].sortNo).toBe(0)
    expect(items[1].sortNo).toBe(1)
  })

  it('recordIds 含不存在 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const r1 = await makeRecord(admin.id)
    const r = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [r1.rec.id, 'ghost'] })
    expect(r.status).toBe(400)
  })

  it('recordIds 含 VOID → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const ok = await makeRecord(admin.id)
    const voided = await makeRecord(admin.id, { recordStatus: 'VOID' })
    const r = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [ok.rec.id, voided.rec.id] })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('VALID')
  })

  it('recordIds 跨企业 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const other = await makeRecord(admin.id, { enterpriseId: 'OTHER' })
    const r = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [other.rec.id] })
    expect(r.status).toBe(400)
  })

  it('recordIds 重复 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const r1 = await makeRecord(admin.id)
    const r = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [r1.rec.id, r1.rec.id] })
    expect(r.status).toBe(400)
    expect(r.body.error).toContain('重复')
  })

  it('recordIds 空 → 400', async () => {
    const { token } = await makeAdminToken()
    const r = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [] })
    expect(r.status).toBe(400)
  })

  it('packageScene 非法 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const r1 = await makeRecord(admin.id)
    const r = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'BOGUS', recordIds: [r1.rec.id] })
    expect(r.status).toBe(400)
  })

  it('user role → 403', async () => {
    const u = await createUser({ role: 'user' })
    const token = getTestToken(u.id, 'user')
    const r = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: ['x'] })
    expect(r.status).toBe(403)
  })
})

describe('GET /packages', () => {
  it('list 默认 + enterpriseId 隔离 + 按 status/scene/keyword 筛选', async () => {
    const { admin, token } = await makeAdminToken()
    await prisma.standardExecutionPackage.create({ data: { enterpriseId: 'DEFAULT', title: '客户审核 19001', packageScene: 'CUSTOMER_AUDIT', createdBy: admin.id } })
    await prisma.standardExecutionPackage.create({ data: { enterpriseId: 'DEFAULT', title: '内部检查', packageScene: 'INTERNAL_CHECK', status: 'READY', generatedAt: new Date(), createdBy: admin.id } })
    await prisma.standardExecutionPackage.create({ data: { enterpriseId: 'OTHER', title: 'other', packageScene: 'INTERNAL_CHECK', createdBy: admin.id } })

    const r1 = await request(app)
      .get('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
    expect(r1.body.total).toBe(2)

    const r2 = await request(app)
      .get('/api/admin/standard-execution/packages?status=READY')
      .set('Authorization', `Bearer ${token}`)
    expect(r2.body.total).toBe(1)

    const r3 = await request(app)
      .get('/api/admin/standard-execution/packages?packageScene=CUSTOMER_AUDIT')
      .set('Authorization', `Bearer ${token}`)
    expect(r3.body.total).toBe(1)

    const r4 = await request(app)
      .get('/api/admin/standard-execution/packages?keyword=19001')
      .set('Authorization', `Bearer ${token}`)
    expect(r4.body.total).toBe(1)
  })
})

describe('GET /packages/:id — 树状目录', () => {
  it('返回 source → requirement[] → task[] → submission[] → reviewLogs[] + attachments[] 完整结构', async () => {
    const { admin, token } = await makeAdminToken()
    const r1 = await makeRecord(admin.id)
    // 加 1 个 attachment + 1 个 reviewLog 到该 submission
    await prisma.standardExecutionAttachment.create({
      data: { enterpriseId: 'DEFAULT', bizType: 'SUBMISSION', bizId: r1.sub.id, fileName: 'a.jpg', fileUrl: '/x', uploadedBy: r1.user.id },
    })
    await prisma.standardExecutionReviewLog.create({
      data: { enterpriseId: 'DEFAULT', submissionId: r1.sub.id, taskId: r1.task.id, action: 'APPROVE', fromStatus: 'SUBMITTED', toStatus: 'APPROVED', reviewerId: admin.id },
    })

    const create = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [r1.rec.id] })
    const pkgId = create.body.data.id

    const r = await request(app)
      .get(`/api/admin/standard-execution/packages/${pkgId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(200)
    expect(r.body.data.tree.length).toBe(1)
    const sNode = r.body.data.tree[0]
    expect(sNode.source.id).toBe(r1.src.id)
    expect(sNode.requirements.length).toBe(1)
    const rNode = sNode.requirements[0]
    expect(rNode.requirement.id).toBe(r1.req.id)
    expect(rNode.tasks.length).toBe(1)
    const tNode = rNode.tasks[0]
    expect(tNode.task.id).toBe(r1.task.id)
    expect(tNode.submissions.length).toBe(1)
    const subNode = tNode.submissions[0]
    expect(subNode.submission.id).toBe(r1.sub.id)
    expect(subNode.record.id).toBe(r1.rec.id)
    expect(subNode.reviewLogs.length).toBe(1)
    expect(subNode.reviewLogs[0].action).toBe('APPROVE')
    expect(subNode.attachments.length).toBe(1)
  })

  it('多个 record 同 source/requirement 时合并到一棵树', async () => {
    const { admin, token } = await makeAdminToken()
    // 注意：makeRecord 每次新建独立 src/req，所以这里手工构造共享 src/req
    const enterpriseId = 'DEFAULT'
    const u1 = await createUser({ role: 'user' })
    const u2 = await createUser({ role: 'user' })
    const src = await prisma.standardExecutionSource.create({ data: { enterpriseId, title: 'sharedSrc', sourceType: 'PRODUCT_STANDARD', createdBy: admin.id } })
    const req = await prisma.standardExecutionRequirement.create({ data: { enterpriseId, sourceId: src.id, title: 'sharedReq', requirementText: 'x', status: 'ACTIVE', createdBy: admin.id } })
    const task = await prisma.standardExecutionTask.create({ data: { enterpriseId, requirementId: req.id, title: 'sharedTask', submitRequirement: 'x', deadlineAt: new Date(Date.now() + 86400000), reviewerId: admin.id, status: 'PUBLISHED', createdBy: admin.id } })
    const sub1 = await prisma.standardExecutionSubmission.create({ data: { enterpriseId, taskId: task.id, assigneeId: u1.id, submitText: 'x', status: 'APPROVED', version: 1, isLatest: true } })
    const sub2 = await prisma.standardExecutionSubmission.create({ data: { enterpriseId, taskId: task.id, assigneeId: u2.id, submitText: 'x', status: 'APPROVED', version: 1, isLatest: true } })
    const rec1 = await prisma.standardExecutionRecord.create({ data: { enterpriseId, sourceId: src.id, requirementId: req.id, taskId: task.id, submissionId: sub1.id, assigneeId: u1.id, title: 'rec1', status: 'VALID' } })
    const rec2 = await prisma.standardExecutionRecord.create({ data: { enterpriseId, sourceId: src.id, requirementId: req.id, taskId: task.id, submissionId: sub2.id, assigneeId: u2.id, title: 'rec2', status: 'VALID' } })

    const create = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [rec1.id, rec2.id] })

    const r = await request(app)
      .get(`/api/admin/standard-execution/packages/${create.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(r.body.data.tree.length).toBe(1)
    expect(r.body.data.tree[0].requirements.length).toBe(1)
    expect(r.body.data.tree[0].requirements[0].tasks.length).toBe(1)
    expect(r.body.data.tree[0].requirements[0].tasks[0].submissions.length).toBe(2)
  })

  it('优先使用任务 basisSnapshots 组装树，老关系仅作 fallback', async () => {
    const { admin, token } = await makeAdminToken()
    const r1 = await makeRecord(admin.id)
    await prisma.standardExecutionTask.update({
      where: { id: r1.task.id },
      data: {
        basisSnapshots: [{
          requirementId: r1.req.id,
          sourceId: r1.src.id,
          sourceTitle: '快照来源',
          sourceNo: 'SNAP-001',
          sourceType: 'PRODUCT_STANDARD',
          version: 'v1',
          clauseNo: 'S-1',
          title: '快照执行依据',
          requirementText: '创建任务时的原文',
          executionDescription: '创建任务时的执行说明',
          submitRequirement: '创建任务时的提交要求',
          recommendedTaskType: 'OTHER',
          capturedAt: new Date().toISOString(),
        }],
      },
    })
    await prisma.standardExecutionSource.update({ where: { id: r1.src.id }, data: { title: '后续改名来源' } })
    await prisma.standardExecutionRequirement.update({ where: { id: r1.req.id }, data: { title: '后续改名依据', requirementText: '后续改写原文' } })

    const create = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [r1.rec.id] })
    const res = await request(app)
      .get(`/api/admin/standard-execution/packages/${create.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.data.tree[0].source.title).toBe('快照来源')
    expect(res.body.data.tree[0].requirements[0].requirement.title).toBe('快照执行依据')
    expect(res.body.data.tree[0].requirements[0].requirement.requirementText).toBe('创建任务时的原文')
  })

  it('id 不存在 → 404', async () => {
    const { token } = await makeAdminToken()
    const r = await request(app)
      .get('/api/admin/standard-execution/packages/no-such')
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(404)
  })
})

describe('POST /packages/:id/generate', () => {
  it('preview + DRAFT → READY，生成主报告/索引/附件多文件目录', async () => {
    const { admin, token } = await makeAdminToken()
    const r1 = await makeRecord(admin.id)
    const attachmentDir = path.resolve(process.cwd(), 'uploads', 'standard-execution', 'package-test')
    mkdirSync(attachmentDir, { recursive: true })
    writeFileSync(path.join(attachmentDir, 'proof.txt'), 'proof-content')
    await prisma.standardExecutionAttachment.create({
      data: {
        enterpriseId: 'DEFAULT',
        bizType: 'SUBMISSION',
        bizId: r1.sub.id,
        fileName: 'proof.txt',
        fileUrl: '/uploads/standard-execution/package-test/proof.txt',
        fileSize: 13,
        mimeType: 'text/plain',
        uploadedBy: r1.user.id,
      },
    })
    await prisma.standardExecutionTask.update({
      where: { id: r1.task.id },
      data: {
        basisSnapshots: [{
          requirementId: r1.req.id,
          sourceId: r1.src.id,
          sourceTitle: 'ZIP 快照来源',
          sourceNo: 'ZIP-001',
          sourceType: 'PRODUCT_STANDARD',
          version: 'v1',
          clauseNo: 'ZIP-1',
          title: 'ZIP 快照依据',
          requirementText: 'ZIP 快照原文',
          executionDescription: null,
          submitRequirement: null,
          recommendedTaskType: null,
          capturedAt: new Date().toISOString(),
        }],
      },
    })
    await prisma.standardExecutionRequirement.update({ where: { id: r1.req.id }, data: { title: 'ZIP 后续改名依据' } })
    const create = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [r1.rec.id] })
    const preview = await request(app)
      .post(`/api/admin/standard-execution/packages/${create.body.data.id}/preview`)
      .set('Authorization', `Bearer ${token}`)
      .send({ includeManifest: true, includeAuditTrace: true, includeBasisClauses: true, includeStatisticsSummary: true })
    expect(preview.status).toBe(200)
    expect(preview.body.data.stats.recordCount).toBe(1)
    expect(preview.body.data.stats.attachmentCount).toBe(1)
    expect(preview.body.data.outputFileTree.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining([
      '封面.pdf',
      '目录.pdf',
      'records/01-ZIP-1/提交内容.pdf',
      'records/01-ZIP-1/proof.txt',
      '汇总.pdf',
      'README.txt',
      '主报告.docx',
      '证据附件索引.xlsx',
      '全部材料.zip',
      'manifest.json',
      '审计追溯表.xlsx',
      '依据条款汇编.docx',
      '统计摘要.docx',
    ]))
    expect(preview.body.data.attachmentIndexPreview[0].fileName).toBe('proof.txt')

    const r = await request(app)
      .post(`/api/admin/standard-execution/packages/${create.body.data.id}/generate`)
      .set('Authorization', `Bearer ${token}`)
      .send({ includeManifest: true, includeAuditTrace: true, includeBasisClauses: true, includeStatisticsSummary: true })
    expect(r.status).toBe(200)
    expect(r.body.data.status).toBe('READY')
    expect(r.body.data.format).toBe('FOLDER')
    expect(r.body.data.generationStatus).toBe('READY')
    expect(r.body.data.generatedAt).toBeTruthy()
    expect(r.body.data.fileUrl).toMatch(/^\/uploads\/se-packages\/.+\/README\.txt$/)
    expect(r.body.outputFiles.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining([
      '封面.pdf',
      '目录.pdf',
      'records/01-ZIP-1/提交内容.pdf',
      'records/01-ZIP-1/proof.txt',
      '汇总.pdf',
      'README.txt',
      '主报告.docx',
      '证据附件索引.xlsx',
      '全部材料.zip',
      'manifest.json',
      '审计追溯表.xlsx',
      '依据条款汇编.docx',
      '统计摘要.docx',
    ]))

    const outputDir = path.resolve(process.cwd(), 'uploads', 'se-packages', create.body.data.id)
    expect(existsSync(path.join(outputDir, '封面.pdf'))).toBe(true)
    expect(existsSync(path.join(outputDir, '目录.pdf'))).toBe(true)
    expect(existsSync(path.join(outputDir, '汇总.pdf'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'records', '01-ZIP-1', '提交内容.pdf'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'records', '01-ZIP-1', 'proof.txt'))).toBe(true)
    expect(existsSync(path.join(outputDir, 'README.txt'))).toBe(true)
    expect(existsSync(path.join(outputDir, '证据附件索引.xlsx'))).toBe(true)
    expect(existsSync(path.join(outputDir, '证据附件', r1.task.id, 'proof.txt'))).toBe(true)
    expect(existsSync(path.join(outputDir, '全部材料.zip'))).toBe(true)
    const readme = readFileSync(path.join(outputDir, 'README.txt'), 'utf8')
    expect(readme).toContain('执行记录：1')
    const zip = await JSZip.loadAsync(readFileSync(path.join(outputDir, '全部材料.zip')))
    expect(zip.file('封面.pdf')).toBeTruthy()
    expect(zip.file('目录.pdf')).toBeTruthy()
    expect(zip.file('汇总.pdf')).toBeTruthy()
    expect(zip.file('records/01-ZIP-1/提交内容.pdf')).toBeTruthy()
    expect(zip.file('records/01-ZIP-1/proof.txt')).toBeTruthy()
    expect(zip.file('全部材料.zip')).toBeNull()
    const docx = await JSZip.loadAsync(readFileSync(path.join(outputDir, '主报告.docx')))
    const documentXml = await docx.file('word/document.xml')!.async('string')
    expect(documentXml).toContain('ZIP 快照来源')
    expect(documentXml).toContain('ZIP 快照依据')
    expect(documentXml).toContain('submit body')

    const download = await request(app)
      .get(`/api/admin/standard-execution/packages/${create.body.data.id}/files`)
      .query({ path: '主报告.docx' })
      .set('Authorization', `Bearer ${token}`)
    expect(download.status).toBe(200)
    expect(download.headers['content-disposition']).toContain('attachment')

    const coverDownload = await request(app)
      .get(`/api/admin/standard-execution/packages/${create.body.data.id}/files`)
      .query({ path: '封面.pdf' })
      .set('Authorization', `Bearer ${token}`)
    expect(coverDownload.status).toBe(200)
    expect(coverDownload.headers['content-type']).toContain('application/pdf')
  })

  it('READY → READY 重新生成（doc §五.6）, generatedAt 更新', async () => {
    const { admin, token } = await makeAdminToken()
    const r1 = await makeRecord(admin.id)
    const create = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [r1.rec.id] })
    await request(app)
      .post(`/api/admin/standard-execution/packages/${create.body.data.id}/generate`)
      .set('Authorization', `Bearer ${token}`)
    const first = await prisma.standardExecutionPackage.findUnique({ where: { id: create.body.data.id } })
    await new Promise((r) => setTimeout(r, 10))
    const r2 = await request(app)
      .post(`/api/admin/standard-execution/packages/${create.body.data.id}/generate`)
      .set('Authorization', `Bearer ${token}`)
    expect(r2.status).toBe(200)
    expect(r2.body.data.status).toBe('READY')
    const second = await prisma.standardExecutionPackage.findUnique({ where: { id: create.body.data.id } })
    expect(second!.generatedAt!.getTime()).toBeGreaterThanOrEqual(first!.generatedAt!.getTime())
  })

  it('preview 检测应有附件但未上传的执行记录', async () => {
    const { admin, token } = await makeAdminToken()
    const r1 = await makeRecord(admin.id, {
      taskType: 'ARCHIVE_MATERIAL',
      submitRequirement: '请上传证明材料',
      requiredMaterials: ['证明材料'],
    })
    const create = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [r1.rec.id] })
    const preview = await request(app)
      .post(`/api/admin/standard-execution/packages/${create.body.data.id}/preview`)
      .set('Authorization', `Bearer ${token}`)
    expect(preview.status).toBe(200)
    expect(preview.body.data.missingAttachments).toHaveLength(1)
    expect(preview.body.data.missingAttachments[0].recordId).toBe(r1.rec.id)
  })

  it('preview 跨企业 → 404', async () => {
    const { admin, token } = await makeAdminToken()
    const other = await prisma.standardExecutionPackage.create({
      data: { enterpriseId: 'OTHER', title: 'X', packageScene: 'INTERNAL_CHECK', createdBy: admin.id },
    })
    const res = await request(app)
      .post(`/api/admin/standard-execution/packages/${other.id}/preview`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('VOID → 409', async () => {
    const { admin, token } = await makeAdminToken()
    const pkg = await prisma.standardExecutionPackage.create({
      data: { enterpriseId: 'DEFAULT', title: 'X', packageScene: 'INTERNAL_CHECK', status: 'VOID', createdBy: admin.id },
    })
    const r = await request(app)
      .post(`/api/admin/standard-execution/packages/${pkg.id}/generate`)
      .set('Authorization', `Bearer ${token}`)
    expect(r.status).toBe(409)
  })
})

describe('Package v2 templates / preview / async generation', () => {
  it('happy path — 模板快选 + 范围预选 + 11 项预览 + 异步生成多文件 zip', async () => {
    const { admin, token } = await makeAdminToken()
    const recordDate = new Date('2026-06-10T04:00:00.000Z')
    const r1 = await makeRecord(admin.id, { departmentId: 'dept-quality', recordDate })
    const attachmentDir = path.resolve(process.cwd(), 'uploads', 'standard-execution', 'package-v2-test')
    mkdirSync(attachmentDir, { recursive: true })
    writeFileSync(path.join(attachmentDir, 'audit-proof.txt'), 'audit-proof')
    await prisma.standardExecutionAttachment.create({
      data: {
        enterpriseId: 'DEFAULT',
        bizType: 'SUBMISSION',
        bizId: r1.sub.id,
        fileName: 'audit-proof.txt',
        fileUrl: '/uploads/standard-execution/package-v2-test/audit-proof.txt',
        fileSize: 11,
        mimeType: 'text/plain',
        uploadedBy: r1.user.id,
      },
    })
    await makeRecord(admin.id, {
      departmentId: 'dept-quality',
      recordDate,
      recordStatus: 'VOID',
    })

    const templates = await request(app)
      .get('/api/admin/standard-execution/packages/templates')
      .set('Authorization', `Bearer ${token}`)
    expect(templates.status).toBe(200)
    expect(templates.body.data.map((t: { key: string }) => t.key)).toEqual(expect.arrayContaining([
      'CUSTOMER_AUDIT',
      'CERTIFICATION_PREP',
      'ANNUAL_ARCHIVE',
    ]))

    const create = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: '客户审核包 v2',
        packageScene: 'CUSTOMER_AUDIT',
        templateKey: 'CUSTOMER_AUDIT',
        sourceIds: [r1.src.id],
        departmentIds: ['dept-quality'],
        dateFrom: '2026-06-10T00:00:00.000Z',
        dateTo: '2026-06-11T00:00:00.000Z',
      })
    expect(create.status).toBe(201)
    expect(new Date(create.body.data.dateFrom).toISOString()).toBe('2026-06-10T00:00:00.000Z')
    expect(new Date(create.body.data.dateTo).toISOString()).toBe('2026-06-11T00:00:00.000Z')
    const itemIds = (await prisma.standardExecutionPackageItem.findMany({ where: { packageId: create.body.data.id } }))
      .map((item) => item.recordId)
    expect(itemIds).toEqual([r1.rec.id])

    const options = { includeManifest: true, includeAuditTrace: true, includeBasisClauses: true, includeStatisticsSummary: true }
    const preview = await request(app)
      .post(`/api/admin/standard-execution/packages/${create.body.data.id}/preview`)
      .set('Authorization', `Bearer ${token}`)
      .send(options)
    expect(preview.status).toBe(200)
    expect(preview.body.data.previewItems).toHaveLength(11)
    expect(preview.body.data.cover).toMatchObject({
      enterpriseName: 'DEFAULT',
      packageSceneLabel: '客户审厂',
      auditDateRange: '2026-06-10 ~ 2026-06-11',
    })
    expect(preview.body.data.invalidRecordRisk.hasInvalidRecord).toBe(false)
    expect(preview.body.data.directoryTree).toEqual(expect.arrayContaining(['封面.pdf', '目录.pdf', 'records/', '汇总.pdf', '主报告.docx', '审计追溯表.xlsx', '证据附件/', 'README.txt', '全部材料.zip']))
    const recordDir = `records/01-${r1.rec.id.slice(0, 8)}`
    expect(preview.body.data.outputFileTree.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining([
      '封面.pdf',
      '目录.pdf',
      `${recordDir}/提交内容.pdf`,
      `${recordDir}/audit-proof.txt`,
      '汇总.pdf',
      '主报告.docx',
      '审计追溯表.xlsx',
      `证据附件/${r1.task.id}/audit-proof.txt`,
      'README.txt',
      '全部材料.zip',
    ]))

    const started = await request(app)
      .post(`/api/admin/standard-execution/packages/${create.body.data.id}/generate-async`)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...options, previewConfirmed: true })
    expect(started.status).toBe(202)
    const batchId = started.body.data.batchId
    expect(batchId).toBeTruthy()

    let status
    for (let i = 0; i < 80; i++) {
      status = await request(app)
        .get(`/api/admin/standard-execution/packages/${create.body.data.id}/generation-status`)
        .query({ batchId })
        .set('Authorization', `Bearer ${token}`)
      if (status.body.data.generationStatus === 'READY') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(status!.status).toBe(200)
    expect(status!.body.data.generationStatus).toBe('READY')
    expect(status!.body.data.job.progress).toBe(100)
    expect(status!.body.data.job.outputFiles.map((f: { path: string }) => f.path)).toEqual(expect.arrayContaining([
      '封面.pdf',
      '目录.pdf',
      `${recordDir}/提交内容.pdf`,
      `${recordDir}/audit-proof.txt`,
      '全部材料.zip',
    ]))

    const zipRes = await request(app)
      .get(`/api/admin/standard-execution/packages/${create.body.data.id}/download-zip`)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse(binaryParser)
    expect(zipRes.status).toBe(200)
    expect(decodeURIComponent(zipRes.headers['content-disposition'])).toContain('DEFAULT-客户审厂-2026-06-10~2026-06-11-审计包.zip')
    const zip = await JSZip.loadAsync(zipRes.body)
    expect(zip.file('封面.pdf')).toBeTruthy()
    expect(zip.file('目录.pdf')).toBeTruthy()
    expect(zip.file('汇总.pdf')).toBeTruthy()
    expect(zip.file(`${recordDir}/提交内容.pdf`)).toBeTruthy()
    expect(zip.file(`${recordDir}/audit-proof.txt`)).toBeTruthy()
    expect(zip.file('主报告.docx')).toBeTruthy()
    expect(zip.file('审计追溯表.xlsx')).toBeTruthy()
    expect(zip.file('README.txt')).toBeTruthy()
    expect(zip.file(`证据附件/${r1.task.id}/audit-proof.txt`)).toBeTruthy()
    expect(zip.file('全部材料.zip')).toBeNull()
  })

  it('permission — 普通 user 不能发起异步生成', async () => {
    const { admin, token } = await makeAdminToken()
    const r1 = await makeRecord(admin.id)
    const create = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'X', packageScene: 'INTERNAL_CHECK', recordIds: [r1.rec.id] })
    const user = await createUser({ role: 'user' })
    const res = await request(app)
      .post(`/api/admin/standard-execution/packages/${create.body.data.id}/generate-async`)
      .set('Authorization', `Bearer ${getTestToken(user.id, 'user')}`)
      .send({ previewConfirmed: true })
    expect(res.status).toBe(403)
  })

  it('empty record pool — 范围预选没有 VALID 记录时返回 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: '空记录池',
        packageScene: 'CUSTOMER_AUDIT',
        templateKey: 'CUSTOMER_AUDIT',
        sourceIds: ['no-such-source'],
      })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('未解析到任何 VALID 执行记录')
  })

  it('invalid records risk marker — PackageItem 保留，预览标记后续失效记录', async () => {
    const { admin, token } = await makeAdminToken()
    const r1 = await makeRecord(admin.id)
    const create = await request(app)
      .post('/api/admin/standard-execution/packages')
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '失效风险包', packageScene: 'INTERNAL_CHECK', recordIds: [r1.rec.id] })
    await prisma.standardExecutionRecord.update({ where: { id: r1.rec.id }, data: { status: 'VOID' } })
    await prisma.standardExecutionPackage.update({ where: { id: create.body.data.id }, data: { hasInvalidRecord: true } })

    const preview = await request(app)
      .post(`/api/admin/standard-execution/packages/${create.body.data.id}/preview`)
      .set('Authorization', `Bearer ${token}`)
    expect(preview.status).toBe(200)
    expect(preview.body.data.invalidRecordRisk).toMatchObject({
      hasInvalidRecord: true,
      invalidRecordCount: 1,
      invalidRecordIds: [r1.rec.id],
    })
    const items = await prisma.standardExecutionPackageItem.findMany({ where: { packageId: create.body.data.id } })
    expect(items).toHaveLength(1)
    expect(items[0].recordId).toBe(r1.rec.id)
  })
})

describe('POST /packages/:id/void', () => {
  it('DRAFT → VOID', async () => {
    const { admin, token } = await makeAdminToken()
    const pkg = await prisma.standardExecutionPackage.create({
      data: { enterpriseId: 'DEFAULT', title: 'X', packageScene: 'INTERNAL_CHECK', createdBy: admin.id },
    })
    const r = await request(app)
      .post(`/api/admin/standard-execution/packages/${pkg.id}/void`)
      .set('Authorization', `Bearer ${token}`)
    expect(r.body.data.status).toBe('VOID')
  })

  it('READY → VOID', async () => {
    const { admin, token } = await makeAdminToken()
    const pkg = await prisma.standardExecutionPackage.create({
      data: { enterpriseId: 'DEFAULT', title: 'X', packageScene: 'INTERNAL_CHECK', status: 'READY', generatedAt: new Date(), createdBy: admin.id },
    })
    const r = await request(app)
      .post(`/api/admin/standard-execution/packages/${pkg.id}/void`)
      .set('Authorization', `Bearer ${token}`)
    expect(r.body.data.status).toBe('VOID')
  })

  it('VOID → VOID 幂等 noop', async () => {
    const { admin, token } = await makeAdminToken()
    const pkg = await prisma.standardExecutionPackage.create({
      data: { enterpriseId: 'DEFAULT', title: 'X', packageScene: 'INTERNAL_CHECK', status: 'VOID', createdBy: admin.id },
    })
    const r = await request(app)
      .post(`/api/admin/standard-execution/packages/${pkg.id}/void`)
      .set('Authorization', `Bearer ${token}`)
    expect(r.body.noop).toBe(true)
  })
})

describe('POST /api/admin/standard-execution/packages/batch-void', () => {
  const PATH = '/api/admin/standard-execution/packages/batch-void'
  async function mkPkg(adminId: string, status: 'DRAFT' | 'READY' | 'VOID', enterpriseId = 'DEFAULT') {
    return prisma.standardExecutionPackage.create({
      data: { enterpriseId, title: 'P', packageScene: 'INTERNAL_CHECK', status, createdBy: adminId },
    })
  }

  it('DRAFT/READY → VOID；已 VOID 落入 skipped', async () => {
    const { admin, token } = await makeAdminToken()
    const draft = await mkPkg(admin.id, 'DRAFT')
    const ready = await mkPkg(admin.id, 'READY')
    const voided = await mkPkg(admin.id, 'VOID')
    const res = await request(app)
      .post(PATH)
      .set('Authorization', `Bearer ${token}`)
      .send({ ids: [draft.id, ready.id, voided.id] })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(2)
    expect(res.body.skipped).toBe(1)
    const d = await prisma.standardExecutionPackage.findUnique({ where: { id: draft.id } })
    expect(d?.status).toBe('VOID')
  })

  it('user role → 403', async () => {
    const u = await createUser({ role: 'user' })
    const r = await request(app).post(PATH).set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`).send({ ids: ['x'] })
    expect(r.status).toBe(403)
  })
})
