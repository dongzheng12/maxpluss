import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerEnterpriseRoutes } from '../src/enterpriseRoutes.js'
import { cleanStandardExecutionData } from './seClean.js'
import { cleanAll, createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerEnterpriseRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
  await cleanAll()
  await prisma.enterprise.upsert({
    where: { id: 'ENT_A' },
    update: { name: 'A 企业', status: 'ACTIVE' },
    create: { id: 'ENT_A', name: 'A 企业', code: 'ENT_A', status: 'ACTIVE' },
  })
})

async function enterpriseUser(enterpriseRole = 'ADMIN') {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({ where: { id: user.id }, data: { enterpriseId: 'ENT_A', enterpriseRole } })
  return { user, token: getTestToken(user.id, 'user') }
}

describe('SE source version tracker', () => {
  it('上传新版本后标记旧版本、影响控制点，并阻止旧版本创建任务', async () => {
    const { user, token } = await enterpriseUser('ADMIN')
    const reviewer = await enterpriseUser('REVIEWER')
    const assignee = await enterpriseUser('EMPLOYEE')
    const source = await prisma.standardExecutionSource.create({
      data: {
        enterpriseId: 'ENT_A',
        title: '食品安全标准',
        sourceType: 'PRODUCT_STANDARD',
        sourceNo: 'GB-FS',
        version: '2024',
        rawText: '5.1 温控记录\\n5.2 清洁消毒',
        createdBy: user.id,
      },
    })
    const requirement = await prisma.standardExecutionRequirement.create({
      data: {
        enterpriseId: 'ENT_A',
        sourceId: source.id,
        clauseNo: '5.1',
        title: '温控记录',
        requirementText: '每日记录温控。',
        status: 'ACTIVE',
        createdBy: user.id,
      },
    })

    const created = await request(app)
      .post(`/api/enterprise/standard-execution/sources/${source.id}/versions`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        version: '2026',
        rawText: '5.1 温控记录需每日记录并校验报警\\n5.2 清洁消毒',
      })
    expect(created.status).toBe(201)
    expect(created.body.summary.modified).toContain('5.1')
    expect(created.body.affectedRequirementIds).toContain(requirement.id)

    const oldSource = await prisma.standardExecutionSource.findUniqueOrThrow({ where: { id: source.id } })
    expect(oldSource.isLatestVersion).toBe(false)
    expect(created.body.data.parentSourceId).toBe(source.id)
    const updatedRequirement = await prisma.standardExecutionRequirement.findUniqueOrThrow({ where: { id: requirement.id } })
    expect(updatedRequirement.requiresReview).toBe(true)
    expect(await prisma.standardExecutionRisk.count({ where: { enterpriseId: 'ENT_A', riskType: 'STANDARD_VERSION_UPDATED' } })).toBe(1)

    const plan = await prisma.standardExecutionPlan.create({
      data: {
        enterpriseId: 'ENT_A',
        sourceId: source.id,
        title: '旧版计划',
        status: 'ACTIVE',
        createdBy: user.id,
      },
    })
    const blocked = await request(app)
      .post(`/api/enterprise/standard-execution/plans/${plan.id}/generate-tasks`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        requirementIds: [requirement.id],
        reviewerId: reviewer.user.id,
        assigneeIds: [assignee.user.id],
        taskType: 'INSPECTION_FILL',
      })
    expect(blocked.status).toBe(400)
    expect(blocked.body.error).toContain('旧版本标准')
  })
})
