import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerStandardExecutionRoutes } from '../src/standard-execution/sourceRoutes.js'
import { cleanStandardExecutionData } from './seClean.js'
import { cleanAll, createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
  await cleanAll()
})

async function adminAuth() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

async function enterpriseUserAuth(enterpriseId = 'ENT_A', enterpriseRole = 'ADMIN') {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId, enterpriseRole },
  })
  return { user, token: getTestToken(user.id, 'user') }
}

async function createRequirement(adminId: string, enterpriseId = 'DEFAULT') {
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId,
      title: '食品安全标准',
      sourceType: 'PRODUCT_STANDARD',
      sourceNo: 'GB-FS',
      version: '2026',
      createdBy: adminId,
    },
  })
  const requirement = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId: source.id,
      clauseNo: '5.1',
      title: '温控记录',
      requirementText: '每日记录温控并留档。',
      status: 'ACTIVE',
      createdBy: adminId,
    },
  })
  return { source, requirement }
}

const templateBody = {
  industryCategory: 'FOOD_SAFETY',
  title: '食品安全基础模板',
  sourceNo: 'GB-FS',
  version: '2026',
  description: '基础控制点',
  items: [
    { clauseNo: '5.1', title: '温控记录', requirementText: '每日记录温控并留档。' },
    { clauseNo: '5.2', title: '清洁消毒', requirementText: '按计划完成清洁消毒。' },
  ],
}

describe('SE industry templates', () => {
  it('admin 创建 / 列表 / 详情 / 发布 / 下线模板', async () => {
    const { token } = await adminAuth()
    const created = await request(app)
      .post('/api/admin/standard-execution/industry-templates')
      .set('Authorization', `Bearer ${token}`)
      .send(templateBody)
    expect(created.status).toBe(201)
    expect(created.body.data.controlPointCount).toBe(2)
    expect(created.body.data.items).toHaveLength(2)

    const list = await request(app)
      .get('/api/admin/standard-execution/industry-templates?industryCategory=FOOD_SAFETY')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.total).toBe(1)

    const detail = await request(app)
      .get(`/api/admin/standard-execution/industry-templates/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.items.map((item: { clauseNo: string }) => item.clauseNo)).toEqual(['5.1', '5.2'])

    const published = await request(app)
      .patch(`/api/admin/standard-execution/industry-templates/${created.body.data.id}/publish`)
      .set('Authorization', `Bearer ${token}`)
    expect(published.status).toBe(200)
    expect(published.body.data.status).toBe('PUBLISHED')

    const offlined = await request(app)
      .patch(`/api/admin/standard-execution/industry-templates/${created.body.data.id}/offline`)
      .set('Authorization', `Bearer ${token}`)
    expect(offlined.status).toBe(200)
    expect(offlined.body.data.status).toBe('OFFLINE')
  })

  it('admin 可从企业控制点保存为模板并匿名复制字段', async () => {
    const { admin, token } = await adminAuth()
    const { requirement } = await createRequirement(admin.id)
    const res = await request(app)
      .post('/api/admin/standard-execution/industry-templates/from-requirements')
      .set('Authorization', `Bearer ${token}`)
      .send({
        enterpriseId: 'DEFAULT',
        requirementIds: [requirement.id],
        industryCategory: 'FOOD_SAFETY',
        title: '保存模板',
      })
    expect(res.status).toBe(201)
    expect(res.body.data.items).toHaveLength(1)
    expect(res.body.data.items[0]).toMatchObject({
      clauseNo: '5.1',
      title: '温控记录',
      requirementText: '每日记录温控并留档。',
    })
    expect(res.body.data.items[0].enterpriseId).toBeUndefined()
  })

  it('企业成员可预览并导入已发布模板，生成 DRAFT 控制点并记录 templateId', async () => {
    const { token: adminToken } = await adminAuth()
    const created = await request(app)
      .post('/api/admin/standard-execution/industry-templates')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(templateBody)
    await prisma.sEIndustryTemplate.update({
      where: { id: created.body.data.id },
      data: { status: 'PUBLISHED' },
    })

    const { user, token } = await enterpriseUserAuth('ENT_A', 'ADMIN')
    const list = await request(app)
      .get('/api/enterprise/standard-execution/industry-templates')
      .set('Authorization', `Bearer ${token}`)
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)

    const detail = await request(app)
      .get(`/api/enterprise/standard-execution/industry-templates/${created.body.data.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(detail.status).toBe(200)
    const firstItemId = detail.body.data.items[0].id

    const imported = await request(app)
      .post(`/api/enterprise/standard-execution/industry-templates/${created.body.data.id}/import`)
      .set('Authorization', `Bearer ${token}`)
      .send({ itemIds: [firstItemId] })
    expect(imported.status).toBe(201)
    expect(imported.body.imported).toBe(1)

    const reqs = await prisma.standardExecutionRequirement.findMany({
      where: { enterpriseId: 'ENT_A', industryTemplateId: created.body.data.id },
    })
    expect(reqs).toHaveLength(1)
    expect(reqs[0]).toMatchObject({
      status: 'DRAFT',
      industryTemplateItemId: firstItemId,
      createdBy: user.id,
    })
    const source = await prisma.standardExecutionSource.findUnique({ where: { id: reqs[0].sourceId } })
    expect(source?.sourceNo).toBe('GB-FS')

    const { user: entBUser, token: entBToken } = await enterpriseUserAuth('ENT_B', 'ADMIN')
    const importedByEntB = await request(app)
      .post(`/api/enterprise/standard-execution/industry-templates/${created.body.data.id}/import`)
      .set('Authorization', `Bearer ${entBToken}`)
      .send({ itemIds: [firstItemId] })
    expect(importedByEntB.status).toBe(201)

    const entBReqs = await prisma.standardExecutionRequirement.findMany({
      where: { enterpriseId: 'ENT_B', industryTemplateId: created.body.data.id },
    })
    expect(entBReqs).toHaveLength(1)
    expect(entBReqs[0].createdBy).toBe(entBUser.id)
    expect(await prisma.standardExecutionRequirement.count({
      where: { enterpriseId: 'ENT_A', industryTemplateId: created.body.data.id },
    })).toBe(1)
  })

  it('非企业成员访问企业模板接口 → 403', async () => {
    const plain = await createUser({ role: 'user' })
    const token = getTestToken(plain.id, 'user')
    const res = await request(app)
      .get('/api/enterprise/standard-execution/industry-templates')
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(403)
  })
})
