#!/usr/bin/env node
/**
 * F10 安保行业演示数据完整版。
 *
 * 用法：
 *   pnpm --dir services/api run seed:se-security-demo -- --write
 *   pnpm --dir services/api run seed:se-security-demo -- --prod-demo --write
 *
 * 约束：
 *   - 只写 POC / 本地确认库；拒绝 prod 特征。
 *   - `--prod-demo` 只交付备稿；真实写生产还需 Johannes 单独 ACK 环境锁。
 *   - POC 合成数据统一 `f10-sec-` 前缀；生产备稿 `--prod-demo` 统一 `prod-demo-sec-` 前缀。
 *   - 可重复执行；任务、记录、附件、材料包按固定 ID upsert。
 *   - 为售卖演示口径保留任务状态分布，同时为每个任务生成完整生命周期证据。
 */
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'

const PROD_DEMO = process.argv.includes('--prod-demo')
const PROD_DEMO_ADMIN_PHONE = '18500228507'
const PROD_DEMO_EMPLOYEE_PHONE = '13581916569'
const PROD_DEMO_ACK_VALUE = 'JOHANNES_ACK_PROD_DEMO_20260607'
const ENTERPRISE_ID = process.env.F10_SECURITY_DEMO_ENTERPRISE_ID || (PROD_DEMO ? 'DEMO_SECURITY_ENTERPRISE' : 'DEFAULT')
const PREFIX = process.env.F10_SECURITY_DEMO_PREFIX || (PROD_DEMO ? 'prod-demo-sec' : 'f10-sec')
const PACKAGE_ID = `${PREFIX}-package-customer-audit-full`
const WRITE = process.argv.includes('--write') || process.env.SE_SECURITY_DEMO_WRITE === '1'
const PROOF_PATH = process.env.SE_SECURITY_DEMO_PROOF || (PROD_DEMO ? '/tmp/prod-security-demo-proof.json' : '/tmp/f10-security-demo-proof.json')

function loadDotEnvIfNeeded() {
  if (process.env.DATABASE_URL) return
  for (const candidate of ['/app/.env', path.resolve(process.cwd(), '.env')]) {
    if (!existsSync(candidate)) continue
    const lines = readFileSync(candidate, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue
      const [key, ...rest] = trimmed.split('=')
      if (!process.env[key]) process.env[key] = rest.join('=').replace(/^['"]|['"]$/g, '')
    }
  }
}

loadDotEnvIfNeeded()
const prisma = new PrismaClient()

function assertSafeTarget() {
  loadDotEnvIfNeeded()
  const dbUrl = process.env.DATABASE_URL || ''
  const normalized = dbUrl.toLowerCase()
  if (!dbUrl) throw new Error('DATABASE_URL missing')
  if (/bxz-pg-prod|bxz_prod|prod-pg|:5434/.test(normalized)) {
    if (!PROD_DEMO) {
      throw new Error('Refusing to seed F10 demo data into a production-looking database')
    }
    if (WRITE && process.env.PROD_DEMO_SEED_ACK !== PROD_DEMO_ACK_VALUE) {
      throw new Error(`Refusing --prod-demo write without PROD_DEMO_SEED_ACK=${PROD_DEMO_ACK_VALUE}`)
    }
    return
  }
  const looksPoc = /bxz-pg-poc|bxz_poc|poc/.test(normalized)
  const looksLocal = /localhost|127\.0\.0\.1/.test(normalized)
  if (!looksPoc && !looksLocal && process.env.ALLOW_SECURITY_DEMO_SEED !== '1') {
    throw new Error('Refusing unknown DB. Set ALLOW_SECURITY_DEMO_SEED=1 only after confirming a POC target.')
  }
}

function asJson(value) {
  return value
}

function workday(daysAgo, hour, minute = 0) {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  d.setHours(hour, minute, 0, 0)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1)
  return d
}

function plusDays(date, days, hour = null, minute = 0) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  if (hour !== null) d.setHours(hour, minute, 0, 0)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + (days >= 0 ? 1 : -1))
  return d
}

function uploadRoot() {
  return path.resolve(process.env.UPLOAD_DIR || path.join(process.cwd(), 'uploads'))
}

function standardUploadDir() {
  return path.join(uploadRoot(), 'standard-execution', 'f10')
}

function packageOutputDir(packageId = PACKAGE_ID) {
  return path.resolve(process.env.SE_PACKAGE_OUTPUT_DIR || path.join(process.cwd(), 'uploads', 'se-packages'), packageId)
}

async function fileSize(filePath) {
  return stat(filePath).then((s) => s.size).catch(() => 0)
}

const sources = [
  {
    key: 'gate',
    title: '门岗值守与来访登记规范',
    sourceNo: 'SEC-F10-001',
    sourceType: 'INTERNAL_POLICY',
    clauses: [
      ['1.1', '来访登记核验', 'INSPECTION_FILL', '逐项核对访客证件、预约信息与进出时间，留存来访登记表。', ['来访登记表', '门岗照片']],
      ['1.2', '交接班记录归档', 'ARCHIVE_MATERIAL', '每班交接填写异常、钥匙、对讲机和未完事项，班后归档。', ['交接班记录 PDF']],
      ['1.3', '重点区域门禁巡查', 'INSPECTION_FILL', '对重点区域门禁状态、尾随进入和异常开门记录进行抽查。', ['门禁巡查照片']],
    ],
  },
  {
    key: 'patrol',
    title: '园区巡逻打卡与异常上报规程',
    sourceNo: 'SEC-F10-002',
    sourceType: 'CHECKLIST',
    clauses: [
      ['2.1', '夜间巡更签到', 'INSPECTION_FILL', '按路线完成巡更点打卡，发现异常即时拍照上报。', ['巡更签到表', '现场照片']],
      ['2.2', '异常事件初报', 'ARCHIVE_MATERIAL', '对可疑人员、门窗异常和设备告警形成初报并归档。', ['异常事件报告']],
      ['2.3', '巡逻器材点检', 'INSPECTION_FILL', '检查手电、对讲机、执法记录仪电量与完好状态。', ['器材点检表']],
    ],
  },
  {
    key: 'escort',
    title: '押运交接与贵重物品护送规范',
    sourceNo: 'SEC-F10-003',
    sourceType: 'INTERNAL_POLICY',
    clauses: [
      ['3.1', '押运任务交接', 'ARCHIVE_MATERIAL', '押运前后双人核验封签、数量、路线和交接签字。', ['押运交接单 PDF']],
      ['3.2', '车辆出发前检查', 'INSPECTION_FILL', '核对车辆油电、胎压、通讯和随车安防装备。', ['车辆检查照片']],
      ['3.3', '突发情况复盘', 'RECTIFICATION', '对押运异常路线、延误或报警事件形成复盘与闭环措施。', ['复盘记录', '整改照片']],
    ],
  },
  {
    key: 'fire',
    title: '消防点检与应急演练制度',
    sourceNo: 'SEC-F10-004',
    sourceType: 'CHECKLIST',
    clauses: [
      ['4.1', '消防器材月度点检', 'INSPECTION_FILL', '检查灭火器压力、铅封、消防栓水压和通道占用。', ['消防点检表', '器材照片']],
      ['4.2', '消防演练签到与讲评', 'TRAINING', '组织消防疏散演练，形成签到、照片和讲评记录。', ['演练签到表', '讲评记录']],
      ['4.3', '隐患整改闭环', 'RECTIFICATION', '对堵塞通道、器材失效等隐患明确责任人和复查时间。', ['整改前后照片']],
    ],
  },
  {
    key: 'qualification',
    title: '安保人员上岗资质管理办法',
    sourceNo: 'SEC-F10-005',
    sourceType: 'INTERNAL_POLICY',
    clauses: [
      ['5.1', '保安员证照复核', 'QUALIFICATION_MATERIAL', '按月复核保安员证、身份证和岗位授权有效期。', ['资质台账', '证照扫描件']],
      ['5.2', '新员工上岗确认', 'ONBOARDING_ACCESS', '新员工完成岗位告知、权限开通和带教确认后方可独立上岗。', ['上岗确认单']],
      ['5.3', '资质到期预警', 'QUALIFICATION_MATERIAL', '对 30 天内到期证照发起提醒并跟进换证材料。', ['换证跟进表']],
    ],
  },
  {
    key: 'training',
    title: '安保岗位培训考核制度',
    sourceNo: 'SEC-F10-006',
    sourceType: 'INTERNAL_POLICY',
    clauses: [
      ['6.1', '岗前培训考核', 'TRAINING', '门岗、巡逻、消防和应急处置岗前培训后需通过考核。', ['培训签到表', '考核成绩单']],
      ['6.2', '月度案例复盘', 'TRAINING', '每月开展典型事件复盘，形成改进要点和人员确认。', ['复盘签到表']],
      ['6.3', '重点岗位再培训', 'TRAINING', '对夜班、押运、消防岗位开展针对性再培训。', ['再培训记录']],
    ],
  },
]

const statusPlan = [
  'DRAFT', 'DRAFT', 'DRAFT',
  'PENDING_APPROVAL', 'PENDING_APPROVAL', 'PENDING_APPROVAL',
  'PUBLISHED', 'PUBLISHED', 'PUBLISHED',
  'IN_PROGRESS', 'IN_PROGRESS', 'IN_PROGRESS',
  'OVERDUE', 'OVERDUE', 'OVERDUE',
  'CANCELLED', 'CANCELLED',
  'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED',
]

const taskTitles = [
  '门岗访客预约抽查准备',
  '消防演练材料草稿整理',
  '保安员证照复核计划草稿',
  '押运车辆检查任务待审批',
  '月度案例复盘任务待审批',
  '重点区域门禁巡查待审批',
  '巡逻器材点检已派发',
  '新员工上岗确认已派发',
  '消防隐患整改任务已派发',
  '夜间巡更签到执行中',
  '押运任务交接执行中',
  '岗前培训考核执行中',
  '资质到期预警已逾期',
  '消防通道占用整改已逾期',
  '异常事件初报已逾期',
  '临时大型活动安保任务已关闭',
  '重复创建的门岗巡查任务已关闭',
  '来访登记抽查完成记录',
  '交接班记录归档完成记录',
  '夜间巡更签到完成记录',
  '押运交接单复核完成记录',
  '消防器材点检完成记录',
  '消防演练签到讲评完成记录',
  '保安员证照复核完成记录',
  '新员工上岗确认完成记录',
  '岗前培训考核完成记录',
  '月度案例复盘完成记录',
]

function buildTasks() {
  return statusPlan.map((status, index) => {
    const source = sources[index % sources.length]
    const clause = source.clauses[index % source.clauses.length]
    const completedIndex = Math.max(0, index - 17)
    return {
      key: String(index + 1).padStart(2, '0'),
      status,
      title: taskTitles[index],
      sourceKey: source.key,
      clauseNo: clause[0],
      taskType: clause[2],
      description: `${taskTitles[index]}：按安保演示流程记录责任人、时间、结果和材料。`,
      submitRequirement: `提交${clause[4].join('、')}，并填写现场处理说明。`,
      assigneeSlot: index % 4,
      daysAgo: status === 'COMPLETED' ? 29 - completedIndex * 3 : 25 - index,
    }
  })
}

const tinyJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Al//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBABAQAAAAAAAAAAAAAAAAAAARD/2gAIAQEAAT8QH//Z',
  'base64',
)

function pdfBytes(title) {
  return Buffer.from([
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 160]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
    `4 0 obj<</Length ${60 + title.length}>>stream`,
    `BT /F1 12 Tf 24 100 Td (${title.replace(/[()]/g, '')}) Tj ET`,
    'endstream endobj',
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
    'xref',
    '0 6',
    '0000000000 65535 f ',
    'trailer<</Root 1 0 R/Size 6>>',
    'startxref',
    '0',
    '%%EOF',
  ].join('\n'))
}

async function ensureAttachmentFile(fileName, content) {
  const dir = standardUploadDir()
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, fileName)
  await writeFile(filePath, content)
  return {
    filePath,
    fileUrl: `/uploads/standard-execution/f10/${fileName}`,
    size: await fileSize(filePath),
  }
}

async function ensureUsers() {
  const enterpriseName = PROD_DEMO ? '星盾安保生产演示企业（DEMO）' : '星盾安保服务有限公司'
  const enterprisePlan = PROD_DEMO ? 'DEMO' : 'POC'
  await prisma.enterprise.upsert({
    where: { id: ENTERPRISE_ID },
    update: { name: enterpriseName, code: ENTERPRISE_ID, status: 'ACTIVE', plan: enterprisePlan },
    create: { id: ENTERPRISE_ID, name: enterpriseName, code: ENTERPRISE_ID, status: 'ACTIVE', plan: enterprisePlan },
  })

  if (PROD_DEMO) {
    const bindProdDemoUser = async ({ phone, fallbackName, enterpriseRole }) => {
      const existing = await prisma.appUser.findUnique({ where: { phone } })
      if (!existing) {
        throw new Error(`Refusing --prod-demo seed: required existing account ${phone} was not found`)
      }
      return prisma.appUser.update({
        where: { id: existing.id },
        data: {
          name: existing.name || fallbackName,
          enterpriseId: ENTERPRISE_ID,
          enterpriseRole,
          role: existing.role || 'user',
          isBlocked: false,
        },
      })
    }
    const admin = await bindProdDemoUser({
      phone: PROD_DEMO_ADMIN_PHONE,
      fallbackName: '赵志安',
      enterpriseRole: 'ADMIN',
    })
    const employee = await bindProdDemoUser({
      phone: PROD_DEMO_EMPLOYEE_PHONE,
      fallbackName: '李巡',
      enterpriseRole: 'EMPLOYEE',
    })
    return { admin, reviewer: admin, employees: [employee] }
  }

  const wanted = [
    { id: `${PREFIX}-admin`, phone: '16652667867', name: '赵志安', enterpriseRole: 'ADMIN' },
    { id: `${PREFIX}-reviewer`, phone: '16698130630', name: '陈安宁', enterpriseRole: 'REVIEWER' },
    { id: `${PREFIX}-employee-gate`, phone: '16610001001', name: '周门岗', enterpriseRole: 'EMPLOYEE' },
    { id: `${PREFIX}-employee-patrol`, phone: '13581916569', name: '李巡', enterpriseRole: 'EMPLOYEE' },
    { id: `${PREFIX}-employee-handover`, phone: '13700001234', name: '王交接', enterpriseRole: 'EMPLOYEE' },
    { id: `${PREFIX}-employee-escort`, phone: '16610001004', name: '孙押运', enterpriseRole: 'EMPLOYEE' },
  ]

  const resolved = []
  for (const user of wanted) {
    const existingByPhone = user.phone
      ? await prisma.appUser.findUnique({ where: { phone: user.phone } })
      : null
    if (existingByPhone) {
      resolved.push(await prisma.appUser.update({
        where: { id: existingByPhone.id },
        data: { name: user.name, enterpriseId: ENTERPRISE_ID, enterpriseRole: user.enterpriseRole, role: 'user', isBlocked: false },
      }))
      continue
    }
    resolved.push(await prisma.appUser.upsert({
      where: { id: user.id },
      update: { phone: user.phone, name: user.name, enterpriseId: ENTERPRISE_ID, enterpriseRole: user.enterpriseRole, role: 'user', isBlocked: false },
      create: { id: user.id, phone: user.phone, name: user.name, enterpriseId: ENTERPRISE_ID, enterpriseRole: user.enterpriseRole, role: 'user', isBlocked: false },
    }))
  }

  const byName = new Map(resolved.map((user) => [user.name, user]))
  return {
    admin: byName.get('赵志安') || resolved[0],
    reviewer: byName.get('陈安宁') || resolved[1],
    employees: ['周门岗', '李巡', '王交接', '孙押运'].map((name) => byName.get(name)).filter(Boolean),
  }
}

async function seedSourcesAndRequirements(users) {
  for (const source of sources) {
    const sourceId = `${PREFIX}-source-${source.key}`
    await prisma.standardExecutionSource.upsert({
      where: { id: sourceId },
      update: {
        enterpriseId: ENTERPRISE_ID,
        title: source.title,
        sourceNo: source.sourceNo,
        sourceType: source.sourceType,
        version: '2026演示版',
        rawText: source.clauses.map((clause) => `${clause[0]} ${clause[1]}：${clause[3]}`).join('\n'),
        status: 'ACTIVE',
        updatedBy: users.admin.id,
      },
      create: {
        id: sourceId,
        enterpriseId: ENTERPRISE_ID,
        title: source.title,
        sourceNo: source.sourceNo,
        sourceType: source.sourceType,
        version: '2026演示版',
        rawText: source.clauses.map((clause) => `${clause[0]} ${clause[1]}：${clause[3]}`).join('\n'),
        status: 'ACTIVE',
        createdBy: users.admin.id,
      },
    })
    for (const clause of source.clauses) {
      const reqId = `${PREFIX}-req-${source.key}-${clause[0].replace('.', '-')}`
      await prisma.standardExecutionRequirement.upsert({
        where: { id: reqId },
        update: {
          enterpriseId: ENTERPRISE_ID,
          sourceId,
          clauseNo: clause[0],
          title: clause[1],
          requirementText: `${clause[0]} ${clause[1]}：${clause[3]}`,
          generateMode: 'RULE',
          status: 'ACTIVE',
          recommendedTaskType: clause[2],
          executionDescription: clause[3],
          submitRequirement: `提交${clause[4].join('、')}`,
          requiredMaterials: asJson(clause[4]),
          updatedBy: users.admin.id,
        },
        create: {
          id: reqId,
          enterpriseId: ENTERPRISE_ID,
          sourceId,
          clauseNo: clause[0],
          title: clause[1],
          requirementText: `${clause[0]} ${clause[1]}：${clause[3]}`,
          generateMode: 'RULE',
          status: 'ACTIVE',
          recommendedTaskType: clause[2],
          executionDescription: clause[3],
          submitRequirement: `提交${clause[4].join('、')}`,
          requiredMaterials: asJson(clause[4]),
          createdBy: users.admin.id,
        },
      })
    }
  }
}

async function seedQuestionBank(users) {
  const questions = [
    ['q1', '门岗发现预约信息不一致时应先做什么？', ['先放行后补登记', '核验身份并联系被访人确认', '口头询问即可'], [1]],
    ['q2', '巡逻发现消防通道被占用，应提交哪类证据？', ['现场照片与整改记录', '个人口头说明', '无需记录'], [0]],
    ['q3', '押运交接单必须包含哪些信息？', ['封签、数量、交接人和时间', '天气', '司机喜好'], [0]],
    ['q4', '保安员证照到期前应如何处理？', ['提前预警并跟进换证材料', '到期后再说', '删除人员信息'], [0]],
    ['q5', '培训考核未通过人员能否独立上岗？', ['可以', '不可以，应补训复考', '由个人决定'], [1]],
    ['q6', '审核通过后的执行记录应进入哪里？', ['记录池与材料包', '个人草稿', '浏览器缓存'], [0]],
  ].map(([id, text, opts, answer], index) => ({
    id,
    type: 'single',
    text,
    opts,
    answer,
    score: index < 4 ? 15 : 20,
    exp: '以安保制度和现场留痕要求为准。',
  }))
  await prisma.sEQuestionBank.upsert({
    where: { id: `${PREFIX}-question-bank` },
    update: {
      enterpriseId: ENTERPRISE_ID,
      title: 'F10 安保岗位培训考核题库',
      description: '覆盖门岗、巡逻、押运、消防、资质和培训的演示题库。',
      questions,
      deletedAt: null,
    },
    create: {
      id: `${PREFIX}-question-bank`,
      enterpriseId: ENTERPRISE_ID,
      title: 'F10 安保岗位培训考核题库',
      description: '覆盖门岗、巡逻、押运、消防、资质和培训的演示题库。',
      questions,
      createdBy: users.admin.id,
    },
  })
}

function assigneeStatusFor(spec) {
  if (PROD_DEMO) {
    if (spec.status === 'COMPLETED') return 'COMPLETED'
    if (spec.status === 'PUBLISHED') return ['07', '08'].includes(spec.key) ? 'PENDING_REVIEW' : 'PENDING'
    if (spec.status === 'IN_PROGRESS') return 'IN_PROGRESS'
    if (spec.status === 'OVERDUE') return 'IN_PROGRESS'
    return 'PENDING'
  }
  return spec.status === 'COMPLETED'
    ? 'COMPLETED'
    : spec.status === 'IN_PROGRESS'
      ? 'IN_PROGRESS'
      : spec.status === 'OVERDUE'
        ? 'OVERDUE'
        : 'PENDING'
}

async function seedTasks(users) {
  const tasks = buildTasks()
  const completedRecords = []
  for (const spec of tasks) {
    const id = `${PREFIX}-task-${spec.key}`
    const reqId = `${PREFIX}-req-${spec.sourceKey}-${spec.clauseNo.replace('.', '-')}`
    const createdAt = workday(spec.daysAgo + 4, 9, 10)
    const submittedForApprovalAt = plusDays(createdAt, 1, 10, 20)
    const approvedAt = plusDays(createdAt, 1, 15, 10)
    const publishedAt = plusDays(approvedAt, 0, 16, 0)
    const submittedAt = workday(spec.daysAgo, 11, 10)
    const reviewedAt = workday(spec.daysAgo, 15, 40)
    const cancelledAt = spec.status === 'CANCELLED' ? workday(Math.max(1, spec.daysAgo - 1), 16, 20) : null
    const deadlineAt = spec.status === 'OVERDUE'
      ? workday(8, 18, 0)
      : spec.status === 'COMPLETED'
        ? plusDays(reviewedAt, 12, 18, 0)
        : plusDays(new Date(), 8 + Number(spec.key), 18, 0)
    const employee = users.employees[spec.assigneeSlot % users.employees.length]
    const assigneeStatus = assigneeStatusFor(spec)

    await prisma.standardExecutionTask.upsert({
      where: { id },
      update: {
        enterpriseId: ENTERPRISE_ID,
        requirementId: reqId,
        title: spec.title,
        description: spec.description,
        taskType: spec.taskType,
        submitRequirement: spec.submitRequirement,
        deadlineAt,
        reviewerId: users.reviewer.id,
        status: spec.status,
        submittedForApprovalAt,
        approvedAt,
        publishedAt,
        completedAt: reviewedAt,
        cancelledAt,
        quizBankId: spec.taskType === 'TRAINING' ? `${PREFIX}-question-bank` : null,
        createdBy: users.admin.id,
        updatedBy: users.admin.id,
        createdAt,
      },
      create: {
        id,
        enterpriseId: ENTERPRISE_ID,
        requirementId: reqId,
        title: spec.title,
        description: spec.description,
        taskType: spec.taskType,
        submitRequirement: spec.submitRequirement,
        deadlineAt,
        reviewerId: users.reviewer.id,
        status: spec.status,
        submittedForApprovalAt,
        approvedAt,
        publishedAt,
        completedAt: reviewedAt,
        cancelledAt,
        quizBankId: spec.taskType === 'TRAINING' ? `${PREFIX}-question-bank` : null,
        createdBy: users.admin.id,
        createdAt,
      },
    })

    await prisma.standardExecutionTaskAssignee.upsert({
      where: { id: `${id}-assignee` },
      update: {
        enterpriseId: ENTERPRISE_ID,
        taskId: id,
        assigneeId: employee.id,
        reviewerId: users.reviewer.id,
        status: assigneeStatus,
        submittedAt,
        reviewedAt,
      },
      create: {
        id: `${id}-assignee`,
        enterpriseId: ENTERPRISE_ID,
        taskId: id,
        assigneeId: employee.id,
        reviewerId: users.reviewer.id,
        status: assigneeStatus,
        submittedAt,
        reviewedAt,
      },
    })

    await prisma.standardExecutionTaskItem.upsert({
      where: { id: `${id}-item-1` },
      update: { taskId: id, requirementId: reqId, status: 'DONE', note: 'F10 演示：执行完成，证据齐备。', completedAt: submittedAt },
      create: { id: `${id}-item-1`, taskId: id, requirementId: reqId, status: 'DONE', note: 'F10 演示：执行完成，证据齐备。', completedAt: submittedAt },
    })
    await prisma.standardExecutionTaskItemProgress.upsert({
      where: { taskItemId_assigneeId: { taskItemId: `${id}-item-1`, assigneeId: employee.id } },
      update: {
        enterpriseId: ENTERPRISE_ID,
        taskId: id,
        requirementId: reqId,
        status: 'DONE',
        note: '员工已按安保演示流程完成现场执行并提交留痕。',
        fileUrls: asJson([`/uploads/standard-execution/f10/${PREFIX}-${spec.key}-record.pdf`]),
        completedAt: submittedAt,
      },
      create: {
        id: `${id}-item-progress-${employee.id}`,
        enterpriseId: ENTERPRISE_ID,
        taskId: id,
        taskItemId: `${id}-item-1`,
        requirementId: reqId,
        assigneeId: employee.id,
        status: 'DONE',
        note: '员工已按安保演示流程完成现场执行并提交留痕。',
        fileUrls: asJson([`/uploads/standard-execution/f10/${PREFIX}-${spec.key}-record.pdf`]),
        completedAt: submittedAt,
      },
    })

    await prisma.standardExecutionTaskApprovalLog.deleteMany({ where: { enterpriseId: ENTERPRISE_ID, taskId: id } })
    if (submittedForApprovalAt) {
      await prisma.standardExecutionTaskApprovalLog.create({
        data: {
          id: `${id}-approval-submit`,
          enterpriseId: ENTERPRISE_ID,
          taskId: id,
          action: 'SUBMIT_APPROVAL',
          fromStatus: 'DRAFT',
          toStatus: 'PENDING_APPROVAL',
          reviewerId: users.admin.id,
          comment: '提交审批：演示任务已配置执行人、审核人、截止时间和材料要求。',
          createdAt: submittedForApprovalAt,
        },
      })
    }
    if (approvedAt) {
      await prisma.standardExecutionTaskApprovalLog.create({
        data: {
          id: `${id}-approval-approve`,
          enterpriseId: ENTERPRISE_ID,
          taskId: id,
          action: 'APPROVE',
          fromStatus: 'PENDING_APPROVAL',
          toStatus: 'PUBLISHED',
          reviewerId: users.reviewer.id,
          comment: '审批通过：按安保排班派发执行，注意留存现场证据。',
          createdAt: approvedAt,
        },
      })
    }

    const submissionId = `${PREFIX}-submission-${spec.key}`
    const recordId = `${PREFIX}-record-${spec.key}`
    await prisma.standardExecutionSubmission.upsert({
      where: { id: submissionId },
      update: {
        enterpriseId: ENTERPRISE_ID,
        taskId: id,
        assigneeId: employee.id,
        submitText: `${employee.name}已完成「${spec.title}」，现场记录、照片和台账已随附件提交。`,
        status: 'APPROVED',
        version: 1,
        isLatest: true,
        submittedAt,
        reviewedAt,
        reviewerId: users.reviewer.id,
        reviewComment: '材料齐全、时间合理、现场证据清晰，审核通过。',
      },
      create: {
        id: submissionId,
        enterpriseId: ENTERPRISE_ID,
        taskId: id,
        assigneeId: employee.id,
        submitText: `${employee.name}已完成「${spec.title}」，现场记录、照片和台账已随附件提交。`,
        status: 'APPROVED',
        version: 1,
        isLatest: true,
        submittedAt,
        reviewedAt,
        reviewerId: users.reviewer.id,
        reviewComment: '材料齐全、时间合理、现场证据清晰，审核通过。',
      },
    })
    await prisma.standardExecutionReviewLog.deleteMany({ where: { enterpriseId: ENTERPRISE_ID, submissionId } })
    await prisma.standardExecutionReviewLog.create({
      data: {
        id: `${PREFIX}-review-log-${spec.key}`,
        enterpriseId: ENTERPRISE_ID,
        submissionId,
        taskId: id,
        action: 'APPROVE',
        fromStatus: 'SUBMITTED',
        toStatus: 'APPROVED',
        reviewerId: users.reviewer.id,
        comment: '审核通过：记录完整，附件可下载，纳入客户审计材料包。',
        createdAt: reviewedAt,
      },
    })
    await prisma.standardExecutionRecord.upsert({
      where: { id: recordId },
      update: {
        enterpriseId: ENTERPRISE_ID,
        sourceId: `${PREFIX}-source-${spec.sourceKey}`,
        requirementId: reqId,
        taskItemId: `${id}-item-1`,
        taskId: id,
        submissionId,
        assigneeId: employee.id,
        title: `${spec.title} · 执行记录`,
        summary: `F10 演示记录：${spec.title}，已审核通过并带完整附件。`,
        recordDate: reviewedAt,
        validUntil: plusDays(reviewedAt, 365, 18, 0),
        status: 'VALID',
        createdFrom: 'REVIEW_APPROVE',
      },
      create: {
        id: recordId,
        enterpriseId: ENTERPRISE_ID,
        sourceId: `${PREFIX}-source-${spec.sourceKey}`,
        requirementId: reqId,
        taskItemId: `${id}-item-1`,
        taskId: id,
        submissionId,
        assigneeId: employee.id,
        title: `${spec.title} · 执行记录`,
        summary: `F10 演示记录：${spec.title}，已审核通过并带完整附件。`,
        recordDate: reviewedAt,
        validUntil: plusDays(reviewedAt, 365, 18, 0),
        status: 'VALID',
        createdFrom: 'REVIEW_APPROVE',
      },
    })

    const pdfName = `${PREFIX}-${spec.key}-record.pdf`
    const jpgName = `${PREFIX}-${spec.key}-scene.jpg`
    const pdf = await ensureAttachmentFile(pdfName, pdfBytes(spec.title))
    const jpg = await ensureAttachmentFile(jpgName, tinyJpeg)
    const attachments = [
      { id: `${PREFIX}-attachment-${spec.key}-pdf`, fileName: pdfName, fileUrl: pdf.fileUrl, fileSize: pdf.size, mimeType: 'application/pdf' },
      { id: `${PREFIX}-attachment-${spec.key}-jpg`, fileName: jpgName, fileUrl: jpg.fileUrl, fileSize: jpg.size, mimeType: 'image/jpeg' },
    ]
    for (const attachment of attachments) {
      await prisma.standardExecutionAttachment.upsert({
        where: { id: attachment.id },
        update: { ...attachment, enterpriseId: ENTERPRISE_ID, bizType: 'SUBMISSION', bizId: submissionId, uploadedBy: employee.id, createdAt: submittedAt },
        create: { ...attachment, enterpriseId: ENTERPRISE_ID, bizType: 'SUBMISSION', bizId: submissionId, uploadedBy: employee.id, createdAt: submittedAt },
      })
    }

    if (spec.taskType === 'TRAINING') {
      await prisma.sEQuizResult.upsert({
        where: { id: `${PREFIX}-quiz-result-${spec.key}` },
        update: {
          enterpriseId: ENTERPRISE_ID,
          taskId: id,
          quizBankId: `${PREFIX}-question-bank`,
          assigneeId: employee.id,
          score: 90,
          totalScore: 100,
          correctCount: 5,
          wrongCount: 1,
          timeUsedSec: 420,
          answers: asJson([{ questionId: 'q1', selected: [1], correct: true }]),
          passed: true,
          submittedAt,
        },
        create: {
          id: `${PREFIX}-quiz-result-${spec.key}`,
          enterpriseId: ENTERPRISE_ID,
          taskId: id,
          quizBankId: `${PREFIX}-question-bank`,
          assigneeId: employee.id,
          score: 90,
          totalScore: 100,
          correctCount: 5,
          wrongCount: 1,
          timeUsedSec: 420,
          answers: asJson([{ questionId: 'q1', selected: [1], correct: true }]),
          passed: true,
          submittedAt,
        },
      })
    }
    completedRecords.push({ recordId, taskId: id, requirementId: reqId, submissionId, title: spec.title })
  }
  return completedRecords
}

async function seedRisks() {
  const risks = [
    {
      id: `${PREFIX}-risk-overdue-credential`,
      riskType: 'TASK_OVERDUE',
      riskLevel: 'HIGH',
      title: '资质到期预警任务已逾期',
      description: '部分保安员证照临近到期，需尽快补齐换证跟进材料。',
      relatedType: 'TASK',
      relatedId: `${PREFIX}-task-13`,
      status: 'UNHANDLED',
    },
    {
      id: `${PREFIX}-risk-review-pending`,
      riskType: 'REVIEW_PENDING',
      riskLevel: 'MEDIUM',
      title: '待审核任务需及时处理',
      description: '巡逻与整改类提交已进入审核队列，建议管理员今日完成审核。',
      relatedType: 'TASK',
      relatedId: `${PREFIX}-task-07`,
      status: 'UNHANDLED',
    },
    {
      id: `${PREFIX}-risk-package-ready`,
      riskType: 'REQUIREMENT_NO_TASK',
      riskLevel: 'LOW',
      title: '客户审计材料包已生成',
      description: '演示材料包附件齐全，可用于客户审计场景下载展示。',
      relatedType: 'PACKAGE',
      relatedId: PACKAGE_ID,
      status: 'HANDLED',
    },
    {
      id: `${PREFIX}-risk-fire-rectification`,
      riskType: 'TASK_OVERDUE',
      riskLevel: 'HIGH',
      title: '消防通道整改闭环需复核',
      description: '消防通道占用整改任务存在逾期风险，需复核现场照片和整改说明。',
      relatedType: 'TASK',
      relatedId: `${PREFIX}-task-14`,
      status: 'UNHANDLED',
    },
    {
      id: `${PREFIX}-risk-training-coverage`,
      riskType: 'ASSIGNEE_NOT_SUBMITTED',
      riskLevel: 'MEDIUM',
      title: '重点岗位再培训覆盖率待跟进',
      description: '夜班、押运、消防岗位再培训需持续跟进人员确认与题库作答。',
      relatedType: 'TASK',
      relatedId: `${PREFIX}-task-11`,
      status: 'UNHANDLED',
    },
  ]
  for (const risk of risks) {
    await prisma.standardExecutionRisk.upsert({
      where: { id: risk.id },
      update: { ...risk, enterpriseId: ENTERPRISE_ID },
      create: { ...risk, enterpriseId: ENTERPRISE_ID },
    })
  }
}

async function generatePackage(records, users) {
  await prisma.standardExecutionPackage.upsert({
    where: { id: PACKAGE_ID },
    update: {
      enterpriseId: ENTERPRISE_ID,
      title: '星盾安保客户审计材料包',
      packageScene: 'CUSTOMER_AUDIT',
      description: 'F10 完整演示包：覆盖门岗、巡逻、押运、消防、资质、培训，附件齐全。',
      status: 'READY',
      format: 'FOLDER',
      hasInvalidRecord: false,
      createdBy: users.admin.id,
    },
    create: {
      id: PACKAGE_ID,
      enterpriseId: ENTERPRISE_ID,
      title: '星盾安保客户审计材料包',
      packageScene: 'CUSTOMER_AUDIT',
      description: 'F10 完整演示包：覆盖门岗、巡逻、押运、消防、资质、培训，附件齐全。',
      status: 'READY',
      format: 'FOLDER',
      hasInvalidRecord: false,
      createdBy: users.admin.id,
    },
  })
  for (const [index, record] of records.entries()) {
    await prisma.standardExecutionPackageItem.upsert({
      where: { id: `${PACKAGE_ID}-item-${String(index + 1).padStart(2, '0')}` },
      update: { enterpriseId: ENTERPRISE_ID, packageId: PACKAGE_ID, recordId: record.recordId, requirementId: record.requirementId, taskId: record.taskId, submissionId: record.submissionId, sortNo: index },
      create: { id: `${PACKAGE_ID}-item-${String(index + 1).padStart(2, '0')}`, enterpriseId: ENTERPRISE_ID, packageId: PACKAGE_ID, recordId: record.recordId, requirementId: record.requirementId, taskId: record.taskId, submissionId: record.submissionId, sortNo: index },
    })
  }

  const root = packageOutputDir()
  await rm(root, { recursive: true, force: true })
  await mkdir(path.join(root, 'files'), { recursive: true })

  const attachmentRows = await prisma.standardExecutionAttachment.findMany({
    where: { enterpriseId: ENTERPRISE_ID, bizType: 'SUBMISSION', bizId: { in: records.map((r) => r.submissionId) } },
    orderBy: { createdAt: 'asc' },
  })
  const outputs = []
  const addOutput = async (relativePath, label, required = true) => {
    outputs.push({ path: relativePath, kind: path.extname(relativePath).slice(1) || 'file', label, required, size: await fileSize(path.join(root, relativePath)) })
  }
  const readme = [
    '# 星盾安保客户审计材料包',
    '',
    `生成时间：${new Date().toISOString()}`,
    `记录数量：${records.length}`,
    `附件数量：${attachmentRows.length}`,
    '',
    '目录说明：files/ 下按任务保留演示附件；证据附件索引.csv 可用于快速核对。',
  ].join('\n')
  await writeFile(path.join(root, 'README.txt'), readme)
  await addOutput('README.txt', '目录索引')
  await writeFile(path.join(root, '主报告.txt'), records.map((r, i) => `${i + 1}. ${r.title}：已审核通过，附件齐备。`).join('\n'))
  await addOutput('主报告.txt', '客户审计主报告')
  const csvRows = ['fileName,type,task,record,relativePath']
  const skippedAttachments = []
  for (const attachment of attachmentRows) {
    const record = records.find((r) => r.submissionId === attachment.bizId)
    const taskDir = record?.taskId || 'task'
    const sourcePath = path.join(uploadRoot(), attachment.fileUrl.replace(/^\/uploads\//, ''))
    const relativePath = `files/${taskDir}/${attachment.fileName}`
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true })
    if (existsSync(sourcePath)) {
      await copyFile(sourcePath, path.join(root, relativePath))
      await addOutput(relativePath, attachment.fileName)
    } else {
      skippedAttachments.push({ fileName: attachment.fileName, fileUrl: attachment.fileUrl, reason: 'LOCAL_FILE_MISSING' })
    }
    csvRows.push([attachment.fileName, attachment.mimeType || '', record?.title || '', record?.recordId || '', relativePath].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
  }
  await writeFile(path.join(root, '证据附件索引.csv'), csvRows.join('\n'))
  await addOutput('证据附件索引.csv', '证据附件索引表')

  const manifest = {
    generatedAt: new Date().toISOString(),
    stats: {
      recordCount: records.length,
      taskCount: new Set(records.map((r) => r.taskId)).size,
      attachmentCount: attachmentRows.length,
    },
    missingAttachments: [],
    skippedAttachments,
    files: outputs,
  }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await addOutput('manifest.json', 'JSON 数据附录', false)

  await prisma.standardExecutionPackage.update({
    where: { id: PACKAGE_ID },
    data: {
      generationStatus: 'READY',
      generationBatchId: `${PREFIX}-${Date.now().toString(36)}`,
      generationOptions: asJson({ includeManifest: true, includeAuditTrace: true, includeBasisClauses: true, includeStatisticsSummary: true }),
      outputDir: root,
      outputManifest: asJson({ ...manifest, files: outputs }),
      generationError: null,
      generatedAt: new Date(),
      fileUrl: `/uploads/se-packages/${PACKAGE_ID}/README.txt`,
    },
  })
  return { root, outputs, skippedAttachments, attachmentRows }
}

async function collectProof(packageResult = null) {
  const [sourceCount, requirementCount, taskStatuses, recordCount, attachmentCount, riskCount, packageRow] = await Promise.all([
    prisma.standardExecutionSource.count({ where: { enterpriseId: ENTERPRISE_ID, id: { startsWith: `${PREFIX}-` } } }),
    prisma.standardExecutionRequirement.count({ where: { enterpriseId: ENTERPRISE_ID, id: { startsWith: `${PREFIX}-` } } }),
    prisma.standardExecutionTask.groupBy({ by: ['status'], where: { enterpriseId: ENTERPRISE_ID, id: { startsWith: `${PREFIX}-` } }, _count: { _all: true }, orderBy: { status: 'asc' } }),
    prisma.standardExecutionRecord.count({ where: { enterpriseId: ENTERPRISE_ID, id: { startsWith: `${PREFIX}-` } } }),
    prisma.standardExecutionAttachment.count({ where: { enterpriseId: ENTERPRISE_ID, id: { startsWith: `${PREFIX}-` } } }),
    prisma.standardExecutionRisk.count({ where: { enterpriseId: ENTERPRISE_ID, id: { startsWith: `${PREFIX}-` } } }),
    prisma.standardExecutionPackage.findUnique({ where: { id: PACKAGE_ID } }),
  ])
  return {
    enterpriseId: ENTERPRISE_ID,
    prefix: PREFIX,
    sourceCount,
    requirementCount,
    taskCount: taskStatuses.reduce((sum, row) => sum + row._count._all, 0),
    taskStatuses: Object.fromEntries(taskStatuses.map((row) => [row.status, row._count._all])),
    recordCount,
    attachmentCount,
    riskCount,
    package: packageRow ? {
      id: packageRow.id,
      title: packageRow.title,
      status: packageRow.status,
      generationStatus: packageRow.generationStatus,
      generatedAt: packageRow.generatedAt,
      outputDir: packageRow.outputDir,
      files: Array.isArray(packageRow.outputManifest?.files) ? packageRow.outputManifest.files.length : 0,
      skippedAttachments: packageRow.outputManifest?.skippedAttachments?.length ?? null,
      missingAttachments: packageRow.outputManifest?.missingAttachments?.length ?? null,
    } : null,
    packageResult: packageResult ? {
      outputRoot: packageResult.root,
      outputFiles: packageResult.outputs.length,
      copiedAttachments: packageResult.attachmentRows.length,
      skippedAttachments: packageResult.skippedAttachments.length,
    } : null,
  }
}

async function main() {
  assertSafeTarget()
  if (!WRITE) {
    const proof = await collectProof()
    console.log(JSON.stringify({ mode: 'dry-run', ...proof }, null, 2))
    return
  }

  const users = await ensureUsers()
  await seedSourcesAndRequirements(users)
  await seedQuestionBank(users)
  const records = await seedTasks(users)
  await seedRisks()
  const packageResult = await generatePackage(records, users)
  const proof = await collectProof(packageResult)
  await writeFile(PROOF_PATH, JSON.stringify({ mode: 'write', ...proof }, null, 2))
  console.log(JSON.stringify({ mode: 'write', proofPath: PROOF_PATH, ...proof }, null, 2))
}

main()
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
