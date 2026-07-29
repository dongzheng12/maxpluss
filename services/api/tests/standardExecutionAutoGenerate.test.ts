/**
 * standard-execution / auto-generate — 自动解析端到端测试
 *
 * 覆盖：
 *  - 单元：parseByRule（条款切片 + 强约束词 + title 截断）
 *  - 单元：parseByAi（合法 JSON / 非法 JSON / schema 失败）
 *  - 集成 AI_STUB：返回空 drafts，不写库
 *  - 集成 RULE：标准 PG 入库 + clauseNo 透传
 *  - 集成 OCR_AI happy：mock AI 返回合法 JSON，入库 generateMode=AI
 *  - 集成 OCR_AI 降级：
 *      AI 抛错 → degradedReason='AI_FAILED' + generateMode=RULE
 *      AI 返回非法 JSON → degradedReason='AI_INVALID_JSON'
 *      AI 未配置（real callStandardAI）→ degradedReason='AI_NOT_CONFIGURED'
 *      rawText 空 → degradedReason='RAWTEXT_EMPTY'
 *  - dryRun=true 不写库但返回 drafts
 *  - 权限：401 / user 403 / sales 403
 *  - 边界：parseMode 非法 400 / sourceId 不存在 400 / 跨企业 sourceId 400
 *  - enterpriseId 隔离：跨企业 source 拒绝
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import express from 'express'
import request from 'supertest'
import mammoth from 'mammoth'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { registerStandardExecutionSourceRoutes } from '../src/standard-execution/sourceRoutes.js'
import { registerStandardExecutionRequirementRoutes } from '../src/standard-execution/requirementRoutes.js'
import { registerStandardExecutionAutoGenerateRoute } from '../src/standard-execution/autoGenerateRoute.js'
import { AiCallFailedError } from '../src/standard-execution/aiClient.js'
import { parseByRule } from '../src/standard-execution/parseRule.js'
import { parseByAi } from '../src/standard-execution/parseAi.js'
import { createUser, getTestToken } from './factory.js'

const BAOAN_FIXTURE = new URL('./fixtures/baoanstandard.docx', import.meta.url)
const ACTION_REQUIREMENT_RE = /(应当|应|必须|不得|禁止|严禁|需要|确保|定期|记录|检查|培训|留存|备案|报备|提交|建立|制定|明确|配备|开展|组织|评估|评审|监视|测量|控制|识别|分类|标识|处置|整改|验证|考核|提供|设置|编制|实施|保持|维护)/

// ─── 测试 app（注入 mock aiCaller）────────────────────

let currentAiCaller: (prompt: string) => Promise<string> = async () => '[]'

const app = express()
app.use(express.json())

beforeAll(() => {
  registerStandardExecutionSourceRoutes(app)
  registerStandardExecutionRequirementRoutes(app)
  // 注入一个可变 aiCaller 适配器，测试用例改 currentAiCaller 即可影响行为
  registerStandardExecutionAutoGenerateRoute(app, (prompt) => currentAiCaller(prompt))
})

beforeEach(async () => {
  // FK 顺序：packageItem → package → reviewLog → attachment → record → submission → assignee → task → requirement → source
  await cleanStandardExecutionData()
  currentAiCaller = async () => '[]'
  delete process.env.STANDARD_AI_BASE_URL
  delete process.env.STANDARD_AI_CANDIDATE_V2
})

async function makeAdminToken() {
  const admin = await createUser({ role: 'admin' })
  return { admin, token: getTestToken(admin.id, 'admin') }
}

async function makeSource(adminId: string, rawText: string, enterpriseId = 'DEFAULT') {
  return prisma.standardExecutionSource.create({
    data: {
      enterpriseId,
      title: '测试标准',
      sourceType: 'PRODUCT_STANDARD',
      rawText,
      createdBy: adminId,
    },
  })
}

const POST = '/api/admin/standard-execution/requirements/auto-generate'

// ═══════════════════════════════════════════════════════
// 单元：parseByRule
// ═══════════════════════════════════════════════════════

describe('parseByRule', () => {
  it('空文本返回空数组', () => {
    expect(parseByRule('')).toEqual([])
    expect(parseByRule('   ')).toEqual([])
  })

  it('提取带强约束词的 X.Y.Z 编号条款', () => {
    const raw = `
5.1.2 设备应每月定期检查一次，记录留存不少于3年
5.1.3 设备说明文档（一般性介绍，无约束动作）
5.1.4 必须对操作人员进行培训，每年不少于4学时
`
    const drafts = parseByRule(raw)
    // 准确优先：有编号但无动作/约束词的描述性条款（5.1.3）不保留。
    expect(drafts.length).toBe(2)
    expect(drafts[0].clauseNo).toBe('5.1.2')
    expect(drafts[0].requirementText).toContain('每月定期检查')
    expect(drafts.map((d) => d.clauseNo)).toEqual(['5.1.2', '5.1.4'])
    expect(drafts[0].executionDescription).toContain('执行并留痕')
  })

  it('提取「第X条」中文编号', () => {
    const raw = `
第三条 操作人员必须经过培训后上岗
第四条 设备使用说明（仅说明，无约束）
第五条 应定期检查消防器材
`
    const drafts = parseByRule(raw)
    expect(drafts.length).toBe(2)
    expect(drafts.map((d) => d.clauseNo)).toEqual(['第三条', '第五条'])
  })

  it('title 截断 ≤ 20 字（超长加省略号）', () => {
    const raw = `5.1 操作人员必须经过严格培训并通过考核才能上岗操作设备记录留存3年`
    const drafts = parseByRule(raw)
    expect(drafts.length).toBe(1)
    expect(drafts[0].title.length).toBeLessThanOrEqual(21) // 20 + …
    expect(drafts[0].title.endsWith('…')).toBe(true)
  })

  it('短于 20 字的 title 不加省略号', () => {
    const raw = `5.1 应每月检查消防器材`
    const drafts = parseByRule(raw)
    expect(drafts.length).toBe(1)
    expect(drafts[0].title.endsWith('…')).toBe(false)
  })

  it('保安服务管理条例样本：准确率 > 80% 且任务字段可执行', async () => {
    const { value } = await mammoth.extractRawText({ buffer: readFileSync(BAOAN_FIXTURE) })
    const drafts = parseByRule(value)
    expect(drafts.length).toBeGreaterThanOrEqual(8)

    const sample = drafts.slice(0, 10)
    expect(sample.length).toBeGreaterThanOrEqual(8)
    const accurate = sample.filter((draft) => (
      ACTION_REQUIREMENT_RE.test(draft.requirementText)
      && !/目录|前言|术语|定义/.test(draft.requirementText)
      && !!draft.executionDescription
      && !!draft.submitRequirement
      && (draft.requiredMaterials?.length ?? 0) > 0
    ))
    expect(accurate.length / sample.length).toBeGreaterThanOrEqual(0.8)
  })

  it('无强约束词的段落跳过', () => {
    const raw = `
5.1 设备说明
5.2 设备型号介绍
5.3 设备规格表
`
    expect(parseByRule(raw)).toEqual([])
  })

  it('无编号纯文本，整篇当一段（含约束词）', () => {
    const raw = '操作人员必须经过培训后上岗'
    const drafts = parseByRule(raw)
    expect(drafts.length).toBe(1)
    expect(drafts[0].clauseNo).toBe(null)
  })

  it('兼容 PDF 提取出的逐字空格与宽松条款编号', () => {
    const raw = `
I  C  S
2 9 . 1 2 0 . 4 0
T / B I  C  A 0 2 2 — 2 0 2 5
目 次
前 言 4 . 4 通 信 能 力 5 . 5 . 3 电 缆 室 带 电 显 示 7 . 2 . 1 检 验 项 目
5 . 3 . 3 压 板 配 置
智 能 终 端 应 具 备 良 好 的 通 信 功 能 ， 支 持 常 用 的 电 力 监 控 系 统 通 信 协 议 ， 并 提 供 相 应 的 物 理 接 口 。
5 . 5 . 3 电 缆 室 带 电 显 示
无 论 主 母 线 是 否 装 传 感 器 ， 当 电 缆 室 A 、 B 、 C 任 一 相 带 电 时 ， 带 电 指 示 灯 应 点 亮 且 颜 色 为 红 色 。
7 . 2 . 1 检 验 项 目
每 批 产 品 出 厂 前 均 应 进 行 出 厂 检 验 ， 检 验 项 目 包 括 外 观 与 结 构 检 查 、 一 次 模 拟 图 动 态 显 示 试 验 。
`
    const drafts = parseByRule(raw)
    expect(drafts.map((d) => d.clauseNo)).toEqual(['5.3.3', '5.5.3', '7.2.1'])
    expect(drafts[0].title).not.toContain('ICS')
    expect(drafts[0].requirementText).toContain('智能终端应具备良好的通信功能')
    expect(drafts[1].requirementText).toContain('带电指示灯应点亮')
  })
})

// ═══════════════════════════════════════════════════════
// 单元：parseByAi
// ═══════════════════════════════════════════════════════

describe('parseByAi', () => {
  it('合法 JSON 数组 → 转 drafts', async () => {
    const fakeAi = async () =>
      JSON.stringify([
        {
          clauseNo: '5.1',
          title: '消防检查',
          requirementText: '消防器材应每月检查一次',
        },
      ])
    const drafts = await parseByAi('rawtext', fakeAi)
    expect(drafts.length).toBe(1)
    expect(drafts[0].clauseNo).toBe('5.1')
  })

  it('P0-5: AI 返回 executionDescription 等可执行字段 → 带入 draft', async () => {
    const fakeAi = async () =>
      JSON.stringify([
        {
          clauseNo: '5.1',
          title: '安全档案',
          requirementText: '企业应建立安全生产记录档案并妥善保存',
          executionDescription: '核查是否建立安全档案，检查责任人/时间/内容/归档位置，上传台账截图',
          recommendedTaskType: 'ARCHIVE_MATERIAL',
          suggestedDepartment: '安全部',
          suggestedFrequency: 'QUARTERLY',
          submitRequirement: '上传安全台账与归档目录',
          requiredMaterials: ['安全台账', '归档目录'],
        },
      ])
    const drafts = await parseByAi('rawtext', fakeAi)
    expect(drafts.length).toBe(1)
    expect(drafts[0].executionDescription).toContain('核查')
    expect(drafts[0].recommendedTaskType).toBe('ARCHIVE_MATERIAL')
    expect(drafts[0].suggestedDepartment).toBe('安全部')
    expect(drafts[0].submitRequirement).toContain('上传')
    expect(drafts[0].requiredMaterials).toEqual(['安全台账', '归档目录'])
  })

  it('合法 JSON 但 requirementText 太短 → 过滤', async () => {
    const fakeAi = async () =>
      JSON.stringify([
        { clauseNo: '5.1', title: 'X', requirementText: '短' },
        { clauseNo: '5.2', title: 'Y', requirementText: '操作人员必须培训' },
      ])
    const drafts = await parseByAi('rawtext', fakeAi)
    expect(drafts.length).toBe(1)
    expect(drafts[0].clauseNo).toBe('5.2')
  })

  it('非法 JSON 抛 AiInvalidJsonError', async () => {
    const fakeAi = async () => 'not json'
    await expect(parseByAi('rawtext', fakeAi)).rejects.toThrow(/非法 JSON/)
  })

  it('schema 校验失败抛 AiInvalidJsonError', async () => {
    const fakeAi = async () => JSON.stringify({ not: 'an array' })
    await expect(parseByAi('rawtext', fakeAi)).rejects.toThrow(/非法 JSON/)
  })

  // DeepSeek/Qwen 等 LLM 偶发用 ```json … ``` 包裹输出，parseByAi 应在 JSON.parse 前剥 fence
  it('被 ```json fence 包裹的合法 JSON → 转 drafts', async () => {
    const fakeAi = async () =>
      '```json\n' +
      JSON.stringify([
        { clauseNo: '5.1', title: '消防检查', requirementText: '消防器材应每月检查一次' },
      ]) +
      '\n```'
    const drafts = await parseByAi('rawtext', fakeAi)
    expect(drafts.length).toBe(1)
    expect(drafts[0].clauseNo).toBe('5.1')
  })

  it('被无标签 ``` fence 包裹的合法 JSON → 转 drafts', async () => {
    const fakeAi = async () =>
      '```\n' +
      JSON.stringify([{ title: 'A', requirementText: '操作人员必须培训' }]) +
      '\n```'
    const drafts = await parseByAi('rawtext', fakeAi)
    expect(drafts.length).toBe(1)
  })

  it('大写 ```JSON fence + 前后空白 → 转 drafts', async () => {
    const fakeAi = async () =>
      '  ```JSON  \n' +
      JSON.stringify([{ title: 'B', requirementText: '记录温度每小时一次' }]) +
      '\n```  '
    const drafts = await parseByAi('rawtext', fakeAi)
    expect(drafts.length).toBe(1)
  })
})

// ═══════════════════════════════════════════════════════
// 集成：AI_STUB
// ═══════════════════════════════════════════════════════

describe('POST auto-generate / AI_STUB', () => {
  it('返回空 drafts + createdCount=0 + 不写库', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id, '一些原文')
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: src.id, parseMode: 'AI_STUB' })
    expect(res.status).toBe(200)
    expect(res.body.data.parseMode).toBe('AI_STUB')
    expect(res.body.data.drafts).toEqual([])
    expect(res.body.data.createdCount).toBe(0)
    const count = await prisma.standardExecutionRequirement.count()
    expect(count).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════
// 集成：RULE
// ═══════════════════════════════════════════════════════

describe('POST auto-generate / RULE', () => {
  it('happy path — 解析 + 入库 + generateMode=RULE', async () => {
    const { admin, token } = await makeAdminToken()
    const raw = `
5.1.2 设备应每月定期检查一次，记录留存不少于3年
5.1.4 必须对操作人员进行培训，每年不少于4学时
`
    const src = await makeSource(admin.id, raw)
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: src.id, parseMode: 'RULE' })
    expect(res.status).toBe(200)
    expect(res.body.data.parseMode).toBe('RULE')
    expect(res.body.data.degraded).toBe(false)
    expect(res.body.data.createdCount).toBe(2)
    expect(res.body.data.ruleCount).toBe(2)
    expect(res.body.data.aiCount).toBe(0)
    expect(res.body.data.degradedCount).toBe(0)

    const rows = await prisma.standardExecutionRequirement.findMany({
      where: { sourceId: src.id },
    })
    expect(rows.length).toBe(2)
    expect(rows.every((r) => r.generateMode === 'RULE')).toBe(true)
    expect(rows.every((r) => r.parseMode === 'RULE')).toBe(true)
    expect(rows.every((r) => r.status === 'REVIEW_PENDING')).toBe(true)
  })

  it('dryRun=true → 返回 drafts 但不写库', async () => {
    const { admin, token } = await makeAdminToken()
    const raw = `5.1.2 应每月检查消防器材`
    const src = await makeSource(admin.id, raw)
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: src.id, parseMode: 'RULE', dryRun: true })
    expect(res.status).toBe(200)
    expect(res.body.data.drafts.length).toBe(1)
    expect(res.body.data.createdCount).toBe(0)
    expect(res.body.data.dryRun).toBe(true)
    const count = await prisma.standardExecutionRequirement.count()
    expect(count).toBe(0)
  })

  it('dryRun RULE 在 candidate v2 开关打开时返回同形态聚合证据', async () => {
    process.env.STANDARD_AI_CANDIDATE_V2 = '1'
    const { admin, token } = await makeAdminToken()
    const raw = `
4.1 门岗值守人员应每日检查访客登记记录并留存门岗系统截图。
4.2 巡逻人员应每班次填写巡逻记录并上传巡更签到表。
`
    const src = await makeSource(admin.id, raw)
    let calls = 0
    currentAiCaller = async () => {
      calls++
      throw new Error('RULE should not call AI')
    }

    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: src.id, parseMode: 'RULE', dryRun: true })

    expect(res.status).toBe(200)
    expect(calls).toBe(0)
    expect(res.body.data.candidateV2Enabled).toBe(true)
    expect(res.body.data.candidateRequirements).toHaveLength(2)
    expect(res.body.data.taskPackages.length).toBeGreaterThan(0)
    expect(res.body.data.coverageReport.totalCandidates).toBe(2)
    expect(res.body.data.drafts.every((draft: { taskDrafts?: Array<{ groupId?: string }> }) => draft.taskDrafts?.[0]?.groupId)).toBe(true)
    expect(res.body.data.createdCount).toBe(0)
    expect(await prisma.standardExecutionRequirement.count()).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════
// 集成：OCR_AI（含降级）
// ═══════════════════════════════════════════════════════

describe('POST auto-generate / OCR_AI', () => {
  it('happy path — AI 返合法 JSON → 入库 generateMode=AI', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id, '原文文本')
    currentAiCaller = async () =>
      JSON.stringify([
        {
          clauseNo: '5.1',
          title: '消防检查',
          requirementText: '消防器材应每月检查一次',
        },
      ])

    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: src.id, parseMode: 'OCR_AI' })
    expect(res.status).toBe(200)
    expect(res.body.data.parseMode).toBe('OCR_AI')
    expect(res.body.data.degraded).toBe(false)
    expect(res.body.data.createdCount).toBe(1)
    expect(res.body.data.aiCount).toBe(1)
    expect(res.body.data.ruleCount).toBe(0)
    const rows = await prisma.standardExecutionRequirement.findMany({ where: { sourceId: src.id } })
    expect(rows[0].generateMode).toBe('AI')
    expect(rows[0].parseMode).toBe('OCR_AI')
    expect(rows[0].degradedReason).toBeNull()
  })

  it('dryRun — AI 候选要求返回 score 分布且不写库', async () => {
    process.env.STANDARD_AI_CANDIDATE_V2 = '1'
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id, '4.1 门岗值守人员应每日检查访客登记记录并留存门岗系统截图。')
    currentAiCaller = async () =>
      JSON.stringify({
        candidateRequirements: [
          {
            clauseNo: '4.1',
            sourceText: '门岗值守人员应每日检查访客登记记录并留存门岗系统截图。',
            action: '门岗值守人员每日检查访客登记记录',
            responsibleRole: '门岗值守人员',
            evidenceType: '访客登记台账、门岗系统截图',
            frequency: '每日',
            riskLevel: 'MEDIUM',
            suggestedTaskType: 'INSPECTION_FILL',
            score: 86,
            mergeable: true,
            mergeReason: '同属门岗记录检查要求',
          },
          {
            clauseNo: '2.1',
            sourceText: '固定岗是指在指定位置执行守护任务的岗位。',
            action: '理解固定岗定义',
            responsibleRole: '安保主管',
            evidenceType: null,
            frequency: null,
            riskLevel: 'LOW',
            suggestedTaskType: 'INSPECTION_FILL',
            score: 42,
            mergeable: false,
            mergeReason: '定义条款不应独立成任务',
          },
        ],
      })

    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: src.id, parseMode: 'OCR_AI', dryRun: true })

    expect(res.status).toBe(200)
    expect(res.body.data.createdCount).toBe(0)
    expect(res.body.data.candidateRequirements).toHaveLength(2)
    expect(res.body.data.candidateScoreDistribution).toMatchObject({
      total: 2,
      belowTaskThreshold: 1,
      taskEligible: 1,
      buckets: { lt60: 1, s60to74: 0, gte75: 1 },
    })
    expect(res.body.data.drafts).toHaveLength(1)
    await expect(prisma.standardExecutionRequirement.count({ where: { sourceId: src.id } })).resolves.toBe(0)
  })

  it('降级 — AI 抛错 → degradedReason=AI_FAILED + 落 RULE 结果', async () => {
    const { admin, token } = await makeAdminToken()
    const raw = `5.1.2 应每月检查消防器材`
    const src = await makeSource(admin.id, raw)
    currentAiCaller = async () => {
      const e = new Error('boom') as Error & { code: string }
      e.code = 'AI_CALL_FAILED'
      throw e
    }
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: src.id, parseMode: 'OCR_AI' })
    expect(res.status).toBe(200)
    expect(res.body.data.parseMode).toBe('RULE')
    expect(res.body.data.degraded).toBe(true)
    expect(res.body.data.degradedReason).toBe('AI_FAILED')
    const rows = await prisma.standardExecutionRequirement.findMany({ where: { sourceId: src.id } })
    expect(rows.length).toBe(1)
    expect(rows[0].generateMode).toBe('RULE')
    expect(rows[0].parseMode).toBe('RULE')
    expect(rows[0].degradedReason).toBe('AI_FAILED')
    expect(res.body.data.ruleCount).toBe(1)
    expect(res.body.data.degradedCount).toBe(1)
  })

  it('降级 — AI timeout → 200 返回 RULE 结果，不抛预览错误', async () => {
    const { admin, token } = await makeAdminToken()
    const raw = `5.1.2 应每月检查消防器材`
    const src = await makeSource(admin.id, raw)
    currentAiCaller = async () => {
      throw new AiCallFailedError('LLM primary timeout after 120000ms')
    }
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: src.id, parseMode: 'OCR_AI', dryRun: true })

    expect(res.status).toBe(200)
    expect(res.body.data.parseMode).toBe('RULE')
    expect(res.body.data.degraded).toBe(true)
    expect(res.body.data.degradedReason).toBe('AI_FAILED')
    expect(res.body.data.createdCount).toBe(0)
    expect(res.body.data.warnings.join('\n')).toContain('AI 解析全部失败')
  })

  it('降级 — AI 返非法 JSON → degradedReason=AI_INVALID_JSON', async () => {
    const { admin, token } = await makeAdminToken()
    const raw = `5.1.2 应每月检查消防器材`
    const src = await makeSource(admin.id, raw)
    currentAiCaller = async () => 'not a json'
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: src.id, parseMode: 'OCR_AI' })
    expect(res.status).toBe(200)
    expect(res.body.data.degradedReason).toBe('AI_INVALID_JSON')
    expect(res.body.data.parseMode).toBe('RULE')
  })

  it('降级 — rawText 空 → degradedReason=RAWTEXT_EMPTY', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id, '') // 空 rawText
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: src.id, parseMode: 'OCR_AI' })
    expect(res.status).toBe(200)
    expect(res.body.data.degraded).toBe(true)
    expect(res.body.data.degradedReason).toBe('RAWTEXT_EMPTY')
    expect(res.body.data.parseMode).toBe('RULE')
    expect(res.body.data.createdCount).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════
// 权限 / 边界
// ═══════════════════════════════════════════════════════

describe('POST auto-generate / 权限 + 边界', () => {
  it('无 token → 401', async () => {
    const res = await request(app)
      .post(POST)
      .send({ sourceId: 'x', parseMode: 'RULE' })
    expect(res.status).toBe(401)
  })

  it('user role → 403', async () => {
    const u = await createUser({ role: 'user' })
    const token = getTestToken(u.id, 'user')
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: 'x', parseMode: 'RULE' })
    expect(res.status).toBe(403)
  })

  it('sales role → 403', async () => {
    const u = await createUser({ role: 'sales' })
    const token = getTestToken(u.id, 'sales')
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: 'x', parseMode: 'RULE' })
    expect(res.status).toBe(403)
  })

  it('parseMode 非法 → 400', async () => {
    const { admin, token } = await makeAdminToken()
    const src = await makeSource(admin.id, 'x')
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: src.id, parseMode: 'BOGUS' })
    expect(res.status).toBe(400)
  })

  it('sourceId 不存在 → 400', async () => {
    const { token } = await makeAdminToken()
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: 'no-such', parseMode: 'RULE' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('标准来源不存在')
  })

  it('跨企业 sourceId → 400（enterpriseId 隔离）', async () => {
    const { admin, token } = await makeAdminToken()
    const otherSrc = await makeSource(admin.id, '原文', 'OTHER')
    const res = await request(app)
      .post(POST)
      .set('Authorization', `Bearer ${token}`)
      .send({ sourceId: otherSrc.id, parseMode: 'RULE' })
    expect(res.status).toBe(400)
  })
})
