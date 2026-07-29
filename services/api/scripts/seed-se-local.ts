import { Prisma } from '@prisma/client'
import { prisma } from '../src/db.js'
import { hashPassword } from '../src/auth.js'

const ENTERPRISE_ID = 'SE_LOCAL_DEMO'
const SOURCE_ID = 'se-local-source-001'
const PLAN_ID = 'se-local-plan-001'
const BANK_ID = 'se-local-question-bank-001'
const PASSWORD = process.env.SE_LOCAL_SEED_PASSWORD || 'LocalDemo@2026!'
const SOURCE_RAW_TEXT = '4.1 企业应建立并保存标准执行记录，记录应包含责任人、时间、结果和整改情况。4.2 相关岗位人员应接受标准执行培训并通过考核。'

const users = {
  admin: { id: 'se-local-user-admin', phone: '18800000001', name: 'SE 本地企业管理员', enterpriseRole: 'ADMIN' },
  reviewer: { id: 'se-local-user-reviewer', phone: '18800000002', name: 'SE 本地审核员', enterpriseRole: 'REVIEWER' },
  employee: { id: 'se-local-user-employee', phone: '18800000003', name: 'SE 本地员工', enterpriseRole: 'EMPLOYEE' },
  personal: { id: 'se-local-user-personal', phone: '18800000004', name: '本地个人用户', enterpriseRole: null },
} as const

const requirements = [
  ['se-local-req-training', '4.1', '岗位培训确认', 'TRAINING', '组织岗位人员完成标准执行培训，上传签到表和考核结果。'],
  ['se-local-req-qualification', '4.2', '资质材料维护', 'QUALIFICATION_MATERIAL', '核查人员或供应商资质有效期，上传证书或资质清单。'],
  ['se-local-req-access', '4.3', '系统权限开通', 'ONBOARDING_ACCESS', '确认新员工已开通必要系统权限并完成权限复核。'],
  ['se-local-req-inspection', '5.1', '月度现场检查', 'INSPECTION_FILL', '按检查表逐项核查现场执行情况，上传检查表和照片。'],
  ['se-local-req-rectification', '5.2', '问题整改闭环', 'RECTIFICATION', '对不符合项制定整改措施，上传整改前后证据。'],
  ['se-local-req-archive', '6.1', '执行材料归档', 'ARCHIVE_MATERIAL', '将本轮执行材料按检查点归档，上传材料目录。'],
] as const

function assertLocalDatabase() {
  const url = process.env.DATABASE_URL || ''
  const local = url.includes('localhost') || url.includes('127.0.0.1')
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed SE local data when NODE_ENV=production')
  }
  if (!local && process.env.ALLOW_SE_LOCAL_SEED !== '1') {
    throw new Error('Refusing to seed non-local DATABASE_URL. Set ALLOW_SE_LOCAL_SEED=1 only for a known POC database.')
  }
}

async function upsertUser(input: { id: string; phone: string; name: string; enterpriseRole: string | null }) {
  const passwordHash = await hashPassword(PASSWORD)
  return prisma.appUser.upsert({
    where: { phone: input.phone },
    update: {
      name: input.name,
      passwordHash,
      role: 'user',
      enterpriseId: input.enterpriseRole ? ENTERPRISE_ID : null,
      enterpriseRole: input.enterpriseRole,
    },
    create: {
      id: input.id,
      phone: input.phone,
      name: input.name,
      passwordHash,
      role: 'user',
      enterpriseId: input.enterpriseRole ? ENTERPRISE_ID : null,
      enterpriseRole: input.enterpriseRole,
    },
  })
}

async function main() {
  assertLocalDatabase()

  await prisma.enterprise.upsert({
    where: { id: ENTERPRISE_ID },
    update: { name: 'SE 本地演示企业', code: ENTERPRISE_ID, status: 'ACTIVE', plan: 'POC' },
    create: { id: ENTERPRISE_ID, name: 'SE 本地演示企业', code: ENTERPRISE_ID, status: 'ACTIVE', plan: 'POC' },
  })

  const [admin, reviewer, employee, personal] = await Promise.all([
    upsertUser(users.admin),
    upsertUser(users.reviewer),
    upsertUser(users.employee),
    upsertUser(users.personal),
  ])

  await prisma.standardExecutionSource.upsert({
    where: { id: SOURCE_ID },
    update: {
      enterpriseId: ENTERPRISE_ID,
      title: 'SE 本地演示标准',
      sourceNo: 'SE-DEMO-001',
      sourceType: 'PRODUCT_STANDARD',
      rawText: SOURCE_RAW_TEXT,
      status: 'ACTIVE',
      updatedBy: admin.id,
    },
    create: {
      id: SOURCE_ID,
      enterpriseId: ENTERPRISE_ID,
      title: 'SE 本地演示标准',
      sourceNo: 'SE-DEMO-001',
      sourceType: 'PRODUCT_STANDARD',
      rawText: SOURCE_RAW_TEXT,
      status: 'ACTIVE',
      createdBy: admin.id,
    },
  })

  for (const [id, clauseNo, title, taskType, executionDescription] of requirements) {
    await prisma.standardExecutionRequirement.upsert({
      where: { id },
      update: {
        enterpriseId: ENTERPRISE_ID,
        sourceId: SOURCE_ID,
        clauseNo,
        title,
        requirementText: `${clauseNo} ${title}：企业应按标准要求完成执行、记录和归档。`,
        status: 'ACTIVE',
        recommendedTaskType: taskType,
        executionDescription,
        submitRequirement: `提交「${title}」相关证明材料`,
        requiredMaterials: [`${title}记录`, '现场照片或截图'] as Prisma.InputJsonValue,
        updatedBy: admin.id,
      },
      create: {
        id,
        enterpriseId: ENTERPRISE_ID,
        sourceId: SOURCE_ID,
        clauseNo,
        title,
        requirementText: `${clauseNo} ${title}：企业应按标准要求完成执行、记录和归档。`,
        generateMode: 'AI_STUB',
        status: 'ACTIVE',
        recommendedTaskType: taskType,
        executionDescription,
        submitRequirement: `提交「${title}」相关证明材料`,
        requiredMaterials: [`${title}记录`, '现场照片或截图'] as Prisma.InputJsonValue,
        createdBy: admin.id,
      },
    })
  }

  await prisma.standardExecutionPlan.upsert({
    where: { id: PLAN_ID },
    update: { enterpriseId: ENTERPRISE_ID, sourceId: SOURCE_ID, title: 'SE 本地演示第一轮执行', status: 'ACTIVE' },
    create: {
      id: PLAN_ID,
      enterpriseId: ENTERPRISE_ID,
      sourceId: SOURCE_ID,
      title: 'SE 本地演示第一轮执行',
      roundNumber: 1,
      scheduledAt: new Date(),
      status: 'ACTIVE',
      createdBy: admin.id,
    },
  })

  const questions = [
    { id: 'q1', type: 'single', text: '执行检查点时首先应确认什么？', opts: ['检查依据和提交材料', '跳过记录', '只口头确认'], answer: [0], score: 50, exp: '应先确认检查依据、责任人与材料要求。' },
    { id: 'q2', type: 'single', text: '执行结果最终以什么为准？', opts: ['人工审核结论', '口头承诺', '页面颜色'], answer: [0], score: 50, exp: 'AI 建议仅供参考，最终以人工审核为准。' },
  ]
  await prisma.sEQuestionBank.upsert({
    where: { id: BANK_ID },
    update: { enterpriseId: ENTERPRISE_ID, title: 'SE 本地演示题库', description: '仅用于本地 / POC 演示', questions: questions as Prisma.InputJsonValue, deletedAt: null },
    create: { id: BANK_ID, enterpriseId: ENTERPRISE_ID, title: 'SE 本地演示题库', description: '仅用于本地 / POC 演示', questions: questions as Prisma.InputJsonValue, createdBy: admin.id },
  })

  const deadlineAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  const taskRows = [
    { id: 'se-local-task-training', type: 'TRAINING', title: 'SE 本地演示 - 培训任务', reqIds: ['se-local-req-training'], quizBankId: BANK_ID },
    { id: 'se-local-task-inspection', type: 'INSPECTION_FILL', title: 'SE 本地演示 - 检查任务', reqIds: ['se-local-req-inspection', 'se-local-req-archive'], quizBankId: null },
    { id: 'se-local-task-rectification', type: 'RECTIFICATION', title: 'SE 本地演示 - 整改任务', reqIds: ['se-local-req-rectification'], quizBankId: null },
  ]

  for (const task of taskRows) {
    await prisma.standardExecutionTask.upsert({
      where: { id: task.id },
      update: {
        enterpriseId: ENTERPRISE_ID,
        planId: PLAN_ID,
        requirementId: task.reqIds.length === 1 ? task.reqIds[0] : null,
        title: task.title,
        description: `${task.title}：本地演示数据，可用于员工提交、审核和记录池验证。`,
        taskType: task.type,
        submitRequirement: '请逐项填写 TaskItem，并上传证明材料。',
        deadlineAt,
        reviewerId: reviewer.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        quizBankId: task.quizBankId,
        updatedBy: admin.id,
      },
      create: {
        id: task.id,
        enterpriseId: ENTERPRISE_ID,
        planId: PLAN_ID,
        requirementId: task.reqIds.length === 1 ? task.reqIds[0] : null,
        title: task.title,
        description: `${task.title}：本地演示数据，可用于员工提交、审核和记录池验证。`,
        taskType: task.type,
        submitRequirement: '请逐项填写 TaskItem，并上传证明材料。',
        deadlineAt,
        reviewerId: reviewer.id,
        status: 'PUBLISHED',
        publishedAt: new Date(),
        quizBankId: task.quizBankId,
        createdBy: admin.id,
      },
    })
    await prisma.standardExecutionTaskAssignee.upsert({
      where: { id: `${task.id}-assignee` },
      update: { enterpriseId: ENTERPRISE_ID, taskId: task.id, assigneeId: employee.id, status: task.id === 'se-local-task-inspection' ? 'PENDING_REVIEW' : 'PENDING' },
      create: { id: `${task.id}-assignee`, enterpriseId: ENTERPRISE_ID, taskId: task.id, assigneeId: employee.id, status: task.id === 'se-local-task-inspection' ? 'PENDING_REVIEW' : 'PENDING' },
    })
    for (let i = 0; i < task.reqIds.length; i++) {
      await prisma.standardExecutionTaskItem.upsert({
        where: { id: `${task.id}-item-${i + 1}` },
        update: { taskId: task.id, requirementId: task.reqIds[i], status: task.id === 'se-local-task-inspection' ? 'DONE' : 'PENDING', note: task.id === 'se-local-task-inspection' ? '本地演示：员工已完成' : null },
        create: { id: `${task.id}-item-${i + 1}`, taskId: task.id, requirementId: task.reqIds[i], status: task.id === 'se-local-task-inspection' ? 'DONE' : 'PENDING', note: task.id === 'se-local-task-inspection' ? '本地演示：员工已完成' : null },
      })
    }
  }

  await prisma.standardExecutionSubmission.upsert({
    where: { id: 'se-local-submission-pending-review' },
    update: {
      enterpriseId: ENTERPRISE_ID,
      taskId: 'se-local-task-inspection',
      assigneeId: employee.id,
      submitText: '本地演示：月度现场检查已完成，检查表和照片已上传。',
      status: 'SUBMITTED',
      version: 1,
      isLatest: true,
      submittedAt: new Date(),
    },
    create: {
      id: 'se-local-submission-pending-review',
      enterpriseId: ENTERPRISE_ID,
      taskId: 'se-local-task-inspection',
      assigneeId: employee.id,
      submitText: '本地演示：月度现场检查已完成，检查表和照片已上传。',
      status: 'SUBMITTED',
      version: 1,
      isLatest: true,
      submittedAt: new Date(),
    },
  })

  await prisma.standardExecutionRecord.upsert({
    where: { id: 'se-local-record-valid-001' },
    update: {
      enterpriseId: ENTERPRISE_ID,
      sourceId: SOURCE_ID,
      requirementId: 'se-local-req-inspection',
      taskItemId: 'se-local-task-inspection-item-1',
      taskId: 'se-local-task-inspection',
      submissionId: 'se-local-submission-pending-review',
      assigneeId: employee.id,
      title: 'SE 本地演示有效执行记录',
      summary: '用于材料包引用演示的 VALID 记录。',
      status: 'VALID',
    },
    create: {
      id: 'se-local-record-valid-001',
      enterpriseId: ENTERPRISE_ID,
      sourceId: SOURCE_ID,
      requirementId: 'se-local-req-inspection',
      taskItemId: 'se-local-task-inspection-item-1',
      taskId: 'se-local-task-inspection',
      submissionId: 'se-local-submission-pending-review',
      assigneeId: employee.id,
      title: 'SE 本地演示有效执行记录',
      summary: '用于材料包引用演示的 VALID 记录。',
      status: 'VALID',
      createdFrom: 'LOCAL_SEED',
    },
  })

  await prisma.standardExecutionPackage.upsert({
    where: { id: 'se-local-package-001' },
    update: { enterpriseId: ENTERPRISE_ID, title: 'SE 本地演示材料包', packageScene: 'AUDIT', status: 'READY', hasInvalidRecord: false },
    create: { id: 'se-local-package-001', enterpriseId: ENTERPRISE_ID, title: 'SE 本地演示材料包', packageScene: 'AUDIT', status: 'READY', createdBy: admin.id },
  })
  await prisma.standardExecutionPackageItem.upsert({
    where: { id: 'se-local-package-item-001' },
    update: {
      enterpriseId: ENTERPRISE_ID,
      packageId: 'se-local-package-001',
      recordId: 'se-local-record-valid-001',
      requirementId: 'se-local-req-inspection',
      taskId: 'se-local-task-inspection',
      submissionId: 'se-local-submission-pending-review',
    },
    create: {
      id: 'se-local-package-item-001',
      enterpriseId: ENTERPRISE_ID,
      packageId: 'se-local-package-001',
      recordId: 'se-local-record-valid-001',
      requirementId: 'se-local-req-inspection',
      taskId: 'se-local-task-inspection',
      submissionId: 'se-local-submission-pending-review',
    },
  })

  console.log('SE local seed completed.')
  console.log(`Enterprise: ${ENTERPRISE_ID}`)
  console.log(`Password: ${PASSWORD}`)
  console.log('Accounts:')
  console.log(`- enterprise ADMIN    ${admin.phone}`)
  console.log(`- enterprise REVIEWER ${reviewer.phone}`)
  console.log(`- enterprise EMPLOYEE ${employee.phone}`)
  console.log(`- personal user       ${personal.phone}`)
  console.log('Data:')
  console.log(`- source ${SOURCE_ID}`)
  console.log(`- plan   ${PLAN_ID}`)
  console.log(`- pending submission se-local-submission-pending-review`)
  console.log(`- question bank ${BANK_ID}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
