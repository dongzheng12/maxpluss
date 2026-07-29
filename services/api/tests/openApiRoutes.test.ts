import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerOpenApiRoutes, __resetOpenApiRateLimit } from '../src/openApiRoutes.js'
import { cleanStandardExecutionData } from './seClean.js'
import { cleanAll, createUser, getTestToken } from './factory.js'

const webhookCalls: Array<{ url: string; body: string; headers: Record<string, string> }> = []
const app = express()
app.use(express.json())

beforeAll(() => {
  registerOpenApiRoutes(app, {
    webhookSender: async (url, body, headers) => {
      webhookCalls.push({ url, body, headers })
      return { status: 200 }
    },
  })
})

beforeEach(async () => {
  webhookCalls.length = 0
  __resetOpenApiRateLimit()
  await cleanStandardExecutionData()
  await cleanAll()
  await prisma.enterprise.upsert({
    where: { id: 'ENT_OPEN_A' },
    update: { name: '开放企业 A', status: 'ACTIVE' },
    create: { id: 'ENT_OPEN_A', name: '开放企业 A', code: 'ENT_OPEN_A', status: 'ACTIVE' },
  })
})

async function enterpriseUser(enterpriseRole = 'ADMIN') {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({ where: { id: user.id }, data: { enterpriseId: 'ENT_OPEN_A', enterpriseRole } })
  return { user, token: getTestToken(user.id, 'user') }
}

async function createApiKey(token: string, scopes: string[]) {
  const res = await request(app)
    .post('/api/enterprise/open-api/keys')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'MES', scopes })
  expect(res.status).toBe(201)
  return res.body as { data: { id: string }; plainKey: string }
}

async function seedRequirement(userId: string) {
  const source = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'ENT_OPEN_A',
      title: '开放标准',
      sourceType: 'PRODUCT_STANDARD',
      sourceNo: 'OPEN-001',
      createdBy: userId,
    },
  })
  const requirement = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId: 'ENT_OPEN_A',
      sourceId: source.id,
      clauseNo: '4.2',
      title: '外部温控记录',
      requirementText: '外部系统每日推送温控记录。',
      status: 'ACTIVE',
      createdBy: userId,
    },
  })
  return { source, requirement }
}

async function waitFor(predicate: () => Promise<boolean> | boolean) {
  for (let i = 0; i < 20; i += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('condition not met')
}

describe('Open API routes', () => {
  it('企业 ADMIN 可创建 Key，health 可用并写访问日志', async () => {
    const admin = await enterpriseUser('ADMIN')
    const key = await createApiKey(admin.token, ['records:write', 'tasks:read'])

    const health = await request(app)
      .get('/api/open/v1/health')
      .set('Authorization', `Bearer ${key.plainKey}`)
    expect(health.status).toBe(200)
    expect(health.body.enterpriseId).toBe('ENT_OPEN_A')

    await new Promise((resolve) => setTimeout(resolve, 20))
    const logCount = await prisma.enterpriseApiAccessLog.count({ where: { enterpriseId: 'ENT_OPEN_A', apiKeyId: key.data.id, path: '/api/open/v1/health' } })
    expect(logCount).toBe(1)
  })

  it('非 ADMIN 不能管理 Key', async () => {
    const manager = await enterpriseUser('MANAGER')
    const res = await request(app)
      .post('/api/enterprise/open-api/keys')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ name: 'bad', scopes: ['records:write'] })
    expect(res.status).toBe(403)
  })

  it('外部系统可推送证据并触发 task.completed Webhook', async () => {
    const admin = await enterpriseUser('ADMIN')
    const { requirement } = await seedRequirement(admin.user.id)
    const key = await createApiKey(admin.token, ['records:write'])
    const webhook = await request(app)
      .post('/api/enterprise/open-api/webhooks')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ url: 'https://example.com/bxz-webhook', events: ['task.completed'] })
    expect(webhook.status).toBe(201)

    const pushed = await request(app)
      .post('/api/open/v1/records')
      .set('Authorization', `Bearer ${key.plainKey}`)
      .send({
        requirementId: requirement.id,
        executorName: 'MES-1',
        summary: '温控 4 度，正常。',
        fileUrls: ['/uploads/external/temp.xlsx'],
      })

    expect(pushed.status).toBe(201)
    const record = await prisma.standardExecutionRecord.findUniqueOrThrow({ where: { id: pushed.body.data.recordId } })
    expect(record.createdFrom).toBe('EXTERNAL_PUSH')
    expect(record.status).toBe('VALID')
    expect(await prisma.standardExecutionAttachment.count({ where: { bizId: pushed.body.data.submissionId } })).toBe(1)
    await waitFor(() => webhookCalls.some((call) => JSON.parse(call.body).event === 'task.completed'))
    expect(webhookCalls.some((call) => JSON.parse(call.body).event === 'task.completed')).toBe(true)
    expect(webhookCalls[0].headers['X-BXZ-Signature']).toMatch(/^sha256=/)
    await waitFor(async () => (await prisma.enterpriseWebhookDelivery.count({ where: { enterpriseId: 'ENT_OPEN_A', event: 'task.completed', status: 'SUCCESS' } })) === 1)
  })

  it('tasks:read scope 控制任务查询，吊销后立即失效', async () => {
    const admin = await enterpriseUser('ADMIN')
    const { requirement } = await seedRequirement(admin.user.id)
    await prisma.standardExecutionTask.create({
      data: {
        enterpriseId: 'ENT_OPEN_A',
        requirementId: requirement.id,
        title: '待读任务',
        status: 'PUBLISHED',
        createdBy: admin.user.id,
      },
    })
    const readKey = await createApiKey(admin.token, ['tasks:read'])
    const writeKey = await createApiKey(admin.token, ['records:write'])

    const forbidden = await request(app)
      .get('/api/open/v1/tasks')
      .set('Authorization', `Bearer ${writeKey.plainKey}`)
    expect(forbidden.status).toBe(403)

    const listed = await request(app)
      .get('/api/open/v1/tasks')
      .set('Authorization', `Bearer ${readKey.plainKey}`)
    expect(listed.status).toBe(200)
    expect(listed.body.data).toHaveLength(1)

    const revoked = await request(app)
      .delete(`/api/enterprise/open-api/keys/${readKey.data.id}`)
      .set('Authorization', `Bearer ${admin.token}`)
    expect(revoked.status).toBe(200)

    const afterRevoke = await request(app)
      .get('/api/open/v1/health')
      .set('Authorization', `Bearer ${readKey.plainKey}`)
    expect(afterRevoke.status).toBe(403)
  })

  it('同一 Key 每分钟最多 100 次', async () => {
    const admin = await enterpriseUser('ADMIN')
    const key = await createApiKey(admin.token, ['tasks:read'])
    for (let i = 0; i < 100; i += 1) {
      const res = await request(app)
        .get('/api/open/v1/health')
        .set('Authorization', `Bearer ${key.plainKey}`)
      expect(res.status).toBe(200)
    }
    const limited = await request(app)
      .get('/api/open/v1/health')
      .set('Authorization', `Bearer ${key.plainKey}`)
    expect(limited.status).toBe(429)
  })
})
