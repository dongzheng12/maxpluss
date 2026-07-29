import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerStandardExecutionMatrixRoutes } from '../src/standard-execution/matrixRoutes.js'
import { cleanStandardExecutionData } from './seClean.js'
import { cleanAll, createUser, getTestToken } from './factory.js'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionMatrixRoutes(app)
})

beforeEach(async () => {
  await cleanStandardExecutionData()
  await cleanAll()
  for (const id of ['ENT_MATRIX_A', 'ENT_MATRIX_B']) {
    await prisma.enterprise.upsert({
      where: { id },
      update: { name: id, status: 'ACTIVE' },
      create: { id, name: id, code: id, status: 'ACTIVE' },
    })
  }
})

async function enterpriseUser(enterpriseId: string, enterpriseRole: string) {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId, enterpriseRole, name: `${enterpriseId}-${enterpriseRole}` },
  })
  return { user, token: getTestToken(user.id, 'user') }
}

async function seedMatrixData(enterpriseId: string, managerId: string, assigneeId: string) {
  const sourceA = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId,
      title: '食品安全标准',
      sourceNo: 'GB-FOOD',
      sourceType: 'PRODUCT_STANDARD',
      version: '2026',
      createdBy: managerId,
    },
  })
  const sourceB = await prisma.standardExecutionSource.create({
    data: {
      enterpriseId,
      title: '内控检查表',
      sourceNo: 'IC-CHECK',
      sourceType: 'INTERNAL_POLICY',
      version: '1.0',
      createdBy: managerId,
    },
  })
  const reqA = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId: sourceA.id,
      clauseNo: '4.1',
      title: '温控留痕',
      requirementText: '每日留存温控记录。',
      status: 'ACTIVE',
      createdBy: managerId,
    },
  })
  const reqB = await prisma.standardExecutionRequirement.create({
    data: {
      enterpriseId,
      sourceId: sourceB.id,
      clauseNo: 'A.2',
      title: '仓储温控',
      requirementText: '仓储过程需证明温控有效。',
      status: 'ACTIVE',
      createdBy: managerId,
    },
  })
  const task = await prisma.standardExecutionTask.create({
    data: {
      enterpriseId,
      requirementId: reqA.id,
      title: '每日温控记录',
      submitRequirement: '上传温控表',
      status: 'COMPLETED',
      reviewerId: managerId,
      createdBy: managerId,
      completedAt: new Date(),
    },
  })
  await prisma.standardExecutionTaskAssignee.create({
    data: {
      enterpriseId,
      taskId: task.id,
      assigneeId,
      reviewerId: managerId,
      departmentId: 'QA',
      status: 'COMPLETED',
      submittedAt: new Date(),
      reviewedAt: new Date(),
    },
  })
  const submission = await prisma.standardExecutionSubmission.create({
    data: {
      enterpriseId,
      taskId: task.id,
      assigneeId,
      submitText: '温控正常。',
      status: 'APPROVED',
      isLatest: true,
      version: 1,
      reviewedAt: new Date(),
      reviewerId: managerId,
    },
  })
  const record = await prisma.standardExecutionRecord.create({
    data: {
      enterpriseId,
      sourceId: sourceA.id,
      requirementId: reqA.id,
      taskId: task.id,
      submissionId: submission.id,
      assigneeId,
      departmentId: 'QA',
      title: '温控记录',
      status: 'VALID',
      recordDate: new Date(),
    },
  })
  return { sourceA, sourceB, reqA, reqB, task, submission, record }
}

describe('SE compliance matrix', () => {
  it('矩阵展示直接覆盖与复用覆盖，并可查询记录覆盖关系', async () => {
    const manager = await enterpriseUser('ENT_MATRIX_A', 'MANAGER')
    const assignee = await enterpriseUser('ENT_MATRIX_A', 'EMPLOYEE')
    const seeded = await seedMatrixData('ENT_MATRIX_A', manager.user.id, assignee.user.id)

    const coverage = await request(app)
      .post(`/api/enterprise/standard-execution/records/${seeded.record.id}/coverages`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ requirementIds: [seeded.reqB.id] })
    expect(coverage.status).toBe(201)
    expect(coverage.body.created).toBe(1)

    const matrix = await request(app)
      .get('/api/enterprise/standard-execution/compliance-matrix')
      .set('Authorization', `Bearer ${manager.token}`)
    expect(matrix.status).toBe(200)
    expect(matrix.body.total).toBe(2)
    const rows = matrix.body.data.rows as Array<{ id: string; coverageBySource: Record<string, { status: string; recordIds: string[] }> }>
    const rowA = rows.find((row) => row.id === seeded.reqA.id)
    const rowB = rows.find((row) => row.id === seeded.reqB.id)
    expect(rowA?.coverageBySource[seeded.sourceA.id]).toMatchObject({ status: 'DIRECT', recordIds: [seeded.record.id] })
    expect(rowB?.coverageBySource[seeded.sourceA.id]).toMatchObject({ status: 'REUSED', recordIds: [seeded.record.id] })

    const coverages = await request(app)
      .get(`/api/enterprise/standard-execution/records/${seeded.record.id}/coverages`)
      .set('Authorization', `Bearer ${manager.token}`)
    expect(coverages.status).toBe(200)
    expect(coverages.body.data).toHaveLength(1)
    expect(coverages.body.requirements[0].id).toBe(seeded.reqB.id)
  })

  it('复用覆盖写入按企业隔离，员工不能维护', async () => {
    const managerA = await enterpriseUser('ENT_MATRIX_A', 'MANAGER')
    const employeeA = await enterpriseUser('ENT_MATRIX_A', 'EMPLOYEE')
    const managerB = await enterpriseUser('ENT_MATRIX_B', 'MANAGER')
    const seededA = await seedMatrixData('ENT_MATRIX_A', managerA.user.id, employeeA.user.id)
    const seededB = await seedMatrixData('ENT_MATRIX_B', managerB.user.id, managerB.user.id)

    const employeeWrite = await request(app)
      .post(`/api/enterprise/standard-execution/records/${seededA.record.id}/coverages`)
      .set('Authorization', `Bearer ${employeeA.token}`)
      .send({ requirementIds: [seededA.reqB.id] })
    expect(employeeWrite.status).toBe(403)

    const crossTenant = await request(app)
      .post(`/api/enterprise/standard-execution/records/${seededA.record.id}/coverages`)
      .set('Authorization', `Bearer ${managerB.token}`)
      .send({ requirementIds: [seededB.reqB.id] })
    expect(crossTenant.status).toBe(404)

    const matrixB = await request(app)
      .get('/api/enterprise/standard-execution/compliance-matrix')
      .set('Authorization', `Bearer ${managerB.token}`)
    expect(matrixB.status).toBe(200)
    expect(matrixB.body.data.sources.map((source: { id: string }) => source.id)).not.toContain(seededA.sourceA.id)
  })

  it('人工维护控制点映射支持幂等更新', async () => {
    const manager = await enterpriseUser('ENT_MATRIX_A', 'REVIEWER')
    const seeded = await seedMatrixData('ENT_MATRIX_A', manager.user.id, manager.user.id)

    const created = await request(app)
      .post('/api/enterprise/standard-execution/requirement-mappings')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({
        sourceRequirementId: seeded.reqA.id,
        targetRequirementId: seeded.reqB.id,
        mappingType: 'EQUIVALENT',
      })
    expect(created.status).toBe(201)
    expect(created.body.data.mappingType).toBe('EQUIVALENT')

    const updated = await request(app)
      .post('/api/enterprise/standard-execution/requirement-mappings')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({
        sourceRequirementId: seeded.reqA.id,
        targetRequirementId: seeded.reqB.id,
        mappingType: 'PARTIAL',
      })
    expect(updated.status).toBe(201)
    expect(updated.body.data.mappingType).toBe('PARTIAL')

    const listed = await request(app)
      .get('/api/enterprise/standard-execution/requirement-mappings')
      .set('Authorization', `Bearer ${manager.token}`)
    expect(listed.status).toBe(200)
    expect(listed.body.data).toHaveLength(1)
  })

  it('控制点超过 200 条时按页返回', async () => {
    const manager = await enterpriseUser('ENT_MATRIX_A', 'MANAGER')
    const source = await prisma.standardExecutionSource.create({
      data: {
        enterpriseId: 'ENT_MATRIX_A',
        title: '大规模标准',
        sourceType: 'PRODUCT_STANDARD',
        createdBy: manager.user.id,
      },
    })
    await prisma.standardExecutionRequirement.createMany({
      data: Array.from({ length: 205 }, (_, index) => ({
        enterpriseId: 'ENT_MATRIX_A',
        sourceId: source.id,
        clauseNo: `P.${index + 1}`,
        title: `分页控制点 ${index + 1}`,
        requirementText: '分页加载验证。',
        status: 'ACTIVE',
        createdBy: manager.user.id,
      })),
    })

    const firstPage = await request(app)
      .get('/api/enterprise/standard-execution/compliance-matrix?page=1&pageSize=200')
      .set('Authorization', `Bearer ${manager.token}`)
    expect(firstPage.status).toBe(200)
    expect(firstPage.body.total).toBe(205)
    expect(firstPage.body.data.rows).toHaveLength(200)

    const secondPage = await request(app)
      .get('/api/enterprise/standard-execution/compliance-matrix?page=2&pageSize=200')
      .set('Authorization', `Bearer ${manager.token}`)
    expect(secondPage.status).toBe(200)
    expect(secondPage.body.data.rows).toHaveLength(5)
  })
})
