import { writeFileSync, readFileSync, existsSync } from 'node:fs'

type JsonObject = Record<string, unknown>

interface DemoDocument {
  id: string
  title: string
  rawText: string
  expectedClauseNos: string[]
}

interface TaskPackage {
  packageId: string
  title: string
  description: string
  submitRequirement: string
  taskType: string
  responsibleRole: string | null
  evidenceType: string | null
  frequency: string | null
  candidateIndexes: number[]
  requiredMaterials?: string[]
}

interface CandidateRequirement {
  clauseNo: string | null
  sourceText: string
  action: string
  responsibleRole: string | null
  evidenceType: string | null
  frequency: string | null
  score: number
}

interface CoverageEntry {
  candidateIndex: number
  clauseNo: string | null
  sourceText: string
  destination: string
  packageId: string | null
  reason: string
}

interface PreviewResult {
  parseMode: string
  degraded?: boolean
  degradedReason?: string | null
  candidateV2Enabled?: boolean
  candidateRequirements?: CandidateRequirement[]
  candidateScoreDistribution?: JsonObject
  taskPackages?: TaskPackage[]
  coverageReport?: {
    totalCandidates: number
    taskPackageCount: number
    candidateOnlyCount: number
    entries: CoverageEntry[]
  }
  warnings?: string[]
}

const DEMO_DOCUMENTS: DemoDocument[] = [
  {
    id: 'security-service-regulation',
    title: '保安服务管理条例演示节选',
    expectedClauseNos: ['4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.7', '4.8', '4.9', '4.10'],
    rawText: `4 安保服务执行要求
4.1 门岗值守人员应每次核验来访人员身份，登记姓名、单位、联系方式、来访事由和进出时间，并留存来访登记台账或门岗系统截图。
4.2 巡逻人员应每日按规定路线巡查重点区域，发现异常及时报告，并上传巡更签到表和现场照片。
4.3 监控室值守人员应每班次检查视频监控、报警设备运行状态，记录故障、处置和交接情况。
4.4 培训负责人应每季度组织保安员参加岗位培训和应急处置考核，提交培训签到表、课件和考核成绩单。
4.5 资质管理员应每月核验保安员证、消防控制室值班证等资质有效期，形成资质清单并留存证书复印件。
4.6 押运队长应每次押运前检查车辆、通讯设备、防护装备和交接封签，填写押运前检查单。
4.7 安保主管应每月评估应急预案演练准备情况，组织演练复盘并留存演练记录和整改清单。
4.8 班组长应每班完成交接班记录，明确在岗人员、未结事项、钥匙和设备交接情况。
4.9 项目负责人发现客户现场安全隐患后应建立整改台账，明确责任人、完成时限并复查闭环。
4.10 档案管理员应每月归档客户投诉、事件处置、巡逻记录和培训记录，确保材料可下载、可追溯。`,
  },
  {
    id: 'metro-security-inspection',
    title: '城轨安保巡检规范演示节选',
    expectedClauseNos: ['5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '5.8', '5.9', '5.10'],
    rawText: `5 城轨安保巡检要求
5.1 安检员应每班次校验安检机、手持金属探测器和液体检测仪状态，提交设备点检表。
5.2 站厅巡逻人员应每小时巡查进出站口、闸机、客服中心和消防通道，上传巡查记录和异常照片。
5.3 值班队长应每日复核违禁品登记、移交和处置记录，确保记录包含时间、地点、当事人和处置结果。
5.4 监控岗人员应每班次抽查重点摄像头画面清晰度和录像保存状态，形成监控抽查台账。
5.5 培训负责人应每月组织安检识别、突发事件疏散和防恐处置培训，提交签到表和考核成绩。
5.6 应急联络员应每季度核对公安、消防、车站控制室联络清单，保存更新记录。
5.7 物资管理员应每周检查防爆毯、警戒带、急救箱和对讲机，提交物资盘点表和缺失补充记录。
5.8 班组长应每班组织岗位交接，确认未处理事件、设备故障和人员到岗情况并留存交接班记录。
5.9 安保主管应对重复发生的漏检、脱岗或记录缺失问题组织整改复查，形成闭环报告。
5.10 档案管理员应每月汇总巡检、培训、设备点检和违禁品处置记录，归档到客户审计材料包。`,
  },
  {
    id: 'mall-security-audit',
    title: '商业综合体安保审计标准演示节选',
    expectedClauseNos: ['6.1', '6.2', '6.3', '6.4', '6.5', '6.6', '6.7', '6.8', '6.9', '6.10'],
    rawText: `6 商业综合体安保审计要求
6.1 门岗值守人员应每次核对施工人员、外卖人员和访客出入权限，留存来访登记或电子通行记录。
6.2 巡逻人员应每日检查消防通道、配电间、卸货区和屋面通道，提交巡逻路线记录和现场照片。
6.3 消防控制室值班人员应每班次检查火灾报警主机、联动控制柜和电话录音状态，填写值班记录。
6.4 停车场管理员应每日检查车库道闸、监控盲区和充电桩周边安全，提交停车场巡检表。
6.5 培训负责人应每季度组织商场保安员开展客流疏导、反恐防暴和消防疏散培训，提交签到和考核记录。
6.6 资质管理员应每月核查外包安保公司营业执照、保安服务许可证和人员证件，留存资质材料清单。
6.7 安保主管应每月组织夜间安全抽查，记录岗位在岗、巡更签到和事件响应情况。
6.8 项目负责人应对客户审计发现的不合格项制定整改计划，复查整改证据并形成闭环说明。
6.9 物资管理员应每周盘点对讲机、强光手电、防刺背心和应急药箱，提交物资盘点记录。
6.10 档案管理员应每月生成客户审计材料包，包含巡逻、培训、资质、整改和事件处置记录。`,
  },
]

const TASK_PACKAGE_MIN = 8
const TASK_PACKAGE_MAX = 12
const DEFAULT_BASE_URL = 'http://154.8.197.13:8083'

function env(name: string, fallback = '') {
  return process.env[name]?.trim() || fallback
}

function isoStamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

function fail(message: string): never {
  throw new Error(message)
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (options.body ? 'POST' : 'GET'),
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { raw: text }
  }
  if (!res.ok) {
    const detail = typeof body === 'object' && body ? JSON.stringify(body).slice(0, 1000) : text.slice(0, 1000)
    fail(`${options.method ?? 'GET'} ${path} returned ${res.status}: ${detail}`)
  }
  return body as T
}

async function resolveToken(baseUrl: string) {
  const existing = env('T14_ADMIN_TOKEN') || env('E2E_ADMIN_TOKEN')
  if (existing) return existing
  const account = env('T14_ADMIN_PHONE') || env('E2E_ADMIN_PHONE')
  const password = env('T14_ADMIN_PASSWORD') || env('E2E_ADMIN_PASSWORD')
  if (!account || !password) {
    fail('Set T14_ADMIN_TOKEN/E2E_ADMIN_TOKEN or T14_ADMIN_PHONE + T14_ADMIN_PASSWORD before running.')
  }
  const login = await requestJson<{ token?: string }>(baseUrl, '/api/app/auth/login', {
    method: 'POST',
    body: { account, password },
  })
  if (!login.token) fail('Login succeeded but response did not include token.')
  return login.token
}

function dataOf<T>(body: { data?: T }, label: string): T {
  if (!body || body.data === undefined || body.data === null) fail(`${label} response missing data`)
  return body.data
}

async function pollPreviewJob(baseUrl: string, token: string, jobId: string) {
  const timeoutMs = Number(env('T14_JOB_TIMEOUT_MS', '240000'))
  const intervalMs = Number(env('T14_JOB_POLL_MS', '1500'))
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const body = await requestJson<{ data?: { status: string; result?: PreviewResult; error?: { message?: string } } }>(
      baseUrl,
      `/api/enterprise/standard-execution/task-generation/preview/jobs/${encodeURIComponent(jobId)}`,
      { token },
    )
    const job = dataOf(body, 'preview job')
    if (job.status === 'SUCCEEDED') return job.result ?? fail(`Job ${jobId} succeeded without result`)
    if (job.status === 'FAILED') fail(`Job ${jobId} failed: ${job.error?.message ?? 'unknown error'}`)
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  fail(`Job ${jobId} did not finish in ${timeoutMs}ms`)
}

function textOf(value: unknown) {
  return String(value ?? '')
}

function includesAny(text: string, words: string[]) {
  return words.some((word) => text.includes(word))
}

function validate5W(pkg: TaskPackage) {
  const combined = `${pkg.title}\n${pkg.description}\n${pkg.submitRequirement}`
  const checks = {
    who: Boolean(pkg.responsibleRole) || /人员|负责人|主管|队长|管理员|班组长|值守|巡逻|门岗|押运|岗位/.test(combined),
    what: includesAny(combined, ['检查', '核验', '巡查', '培训', '考核', '归档', '整改', '复查', '记录', '提交', '盘点', '交接']),
    when: Boolean(pkg.frequency) || /每次|每日|每天|每班|每小时|每周|每月|每季度|每年|发生时|及时|定期/.test(combined),
    evidence: Boolean(pkg.evidenceType) || Boolean(pkg.submitRequirement) || (pkg.requiredMaterials?.length ?? 0) > 0,
    acceptance: /提交|留存|记录|台账|清单|照片|截图|报告|成绩|证书|闭环|复查|保存|完成/.test(combined),
  }
  return {
    ...checks,
    passed: Object.values(checks).every(Boolean),
  }
}

function unique<T>(items: T[]) {
  return Array.from(new Set(items))
}

function pickSamples(packages: TaskPackage[]) {
  if (packages.length <= 3) return packages
  const indexes = unique([0, Math.floor(packages.length / 2), packages.length - 1])
  return indexes.map((index) => packages[index]).filter(Boolean)
}

function loadLegacyBaseline() {
  const file = env('T14_LEGACY_BASELINE_JSON')
  if (!file || !existsSync(file)) return new Map<string, number>()
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { documents?: Array<{ id: string; oldCardCount?: number; legacyCardCount?: number }> }
  return new Map((raw.documents ?? []).map((item) => [item.id, item.oldCardCount ?? item.legacyCardCount ?? 0]))
}

async function runDocument(baseUrl: string, token: string, doc: DemoDocument, legacyBaseline: Map<string, number>) {
  const submitted = await requestJson<{ data?: { id: string; status: string } }>(
    baseUrl,
    '/api/enterprise/standard-execution/task-generation/preview/jobs',
    {
      token,
      body: {
        rawText: doc.rawText,
        parseMode: 'OCR_AI',
        polish: { enabled: false },
      },
    },
  )
  const job = dataOf(submitted, 'preview job submit')
  if (!job.id) fail(`${doc.title}: preview job response missing id`)
  const result = await pollPreviewJob(baseUrl, token, job.id)
  const candidates = result.candidateRequirements ?? []
  const packages = result.taskPackages ?? []
  const coverageEntries = result.coverageReport?.entries ?? []
  const coveredClauseNos = unique(
    coverageEntries
      .map((entry) => entry.clauseNo)
      .filter((clauseNo): clauseNo is string => Boolean(clauseNo)),
  )
  const missingClauses = doc.expectedClauseNos.filter((clauseNo) => !coveredClauseNos.includes(clauseNo))
  const fiveWResults = packages.map((pkg) => ({
    packageId: pkg.packageId,
    title: pkg.title,
    checks: validate5W(pkg),
  }))
  const fiveWFailures = fiveWResults.filter((item) => !item.checks.passed)

  if (!result.candidateV2Enabled) fail(`${doc.title}: candidateV2Enabled is not true; wait for A to open STANDARD_AI_CANDIDATE_V2 on 8083.`)
  if (!result.coverageReport) fail(`${doc.title}: coverageReport missing`)
  if (packages.length < TASK_PACKAGE_MIN || packages.length > TASK_PACKAGE_MAX) {
    fail(`${doc.title}: taskPackages=${packages.length}, expected ${TASK_PACKAGE_MIN}-${TASK_PACKAGE_MAX}`)
  }
  if (coverageEntries.length !== candidates.length) {
    fail(`${doc.title}: coverage entries ${coverageEntries.length} != candidateRequirements ${candidates.length}`)
  }
  if (missingClauses.length > 0) {
    fail(`${doc.title}: coverageReport missing original clauses: ${missingClauses.join(', ')}`)
  }
  if (fiveWFailures.length > 0) {
    fail(`${doc.title}: 5W failed packages: ${fiveWFailures.map((item) => item.packageId).join(', ')}`)
  }

  const samples = pickSamples(packages).map((pkg) => {
    const sourceCandidates = pkg.candidateIndexes.map((index) => candidates[index]).filter(Boolean)
    return {
      packageId: pkg.packageId,
      title: pkg.title,
      taskType: pkg.taskType,
      responsibleRole: pkg.responsibleRole,
      frequency: pkg.frequency,
      submitRequirement: pkg.submitRequirement,
      clauseNos: sourceCandidates.map((candidate) => candidate.clauseNo).filter(Boolean),
      sourceTexts: sourceCandidates.map((candidate) => candidate.sourceText),
      manualInspection: {
        sourceAligned: 'TODO_BY_HUMAN',
        taskPackageQuality: 'TODO_BY_HUMAN',
        note: '请人工核对任务包是否少而精、是否能从 sourceTexts 对回原文。',
      },
    }
  })

  const legacyCardCount = legacyBaseline.get(doc.id) || candidates.length || result.coverageReport.totalCandidates
  return {
    id: doc.id,
    title: doc.title,
    jobId: job.id,
    parseMode: result.parseMode,
    degraded: Boolean(result.degraded),
    degradedReason: result.degradedReason ?? null,
    warnings: result.warnings ?? [],
    oldPipelineCardCount: legacyCardCount,
    oldPipelineCardCountSource: legacyBaseline.has(doc.id) ? 'T14_LEGACY_BASELINE_JSON' : 'candidateRequirements proxy',
    candidateCount: candidates.length,
    scoreDistribution: result.candidateScoreDistribution ?? null,
    taskPackageCount: packages.length,
    coverage: {
      expectedClauseCount: doc.expectedClauseNos.length,
      coveredClauseCount: coveredClauseNos.length,
      missingClauses,
      candidateCoverageCount: coverageEntries.length,
      candidateOnlyCount: result.coverageReport.candidateOnlyCount,
      coverageRate: doc.expectedClauseNos.length ? coveredClauseNos.length / doc.expectedClauseNos.length : 1,
    },
    fiveW: {
      passed: fiveWFailures.length === 0,
      packageCount: packages.length,
      failures: fiveWFailures,
    },
    qualitySamples: samples,
  }
}

function renderMarkdownReport(payload: JsonObject) {
  const documents = payload.documents as Array<Record<string, unknown>>
  const lines = [
    '# T14 开闸真实链路验证报告',
    '',
    `- Base URL: ${payload.baseUrl}`,
    `- Health commit: ${textOf((payload.health as JsonObject | null)?.commit)}`,
    `- Config: candidateV2Enabled=${textOf((payload.config as JsonObject).candidateV2Enabled)}, candidateMinScore=${textOf((payload.config as JsonObject).candidateMinScore)}, candidateTaskMinScore=${textOf((payload.config as JsonObject).candidateTaskMinScore)}`,
    `- Generated at: ${payload.generatedAt}`,
    '',
    '## 管道前后对比',
    '',
    '| 文档 | 旧管道卡数 | 新任务包数 | 覆盖率 | 5W | 备注 |',
    '| --- | ---: | ---: | ---: | --- | --- |',
    ...documents.map((doc) => {
      const coverage = doc.coverage as JsonObject
      const fiveW = doc.fiveW as JsonObject
      return `| ${doc.title} | ${doc.oldPipelineCardCount} | ${doc.taskPackageCount} | ${Math.round(Number(coverage.coverageRate) * 100)}% | ${fiveW.passed ? 'pass' : 'fail'} | ${doc.oldPipelineCardCountSource} |`
    }),
    '',
    '## 抽样人检记录',
    '',
  ]
  for (const doc of documents) {
    lines.push(`### ${doc.title}`)
    const samples = doc.qualitySamples as Array<Record<string, unknown>>
    for (const sample of samples) {
      lines.push(`- ${sample.title} (${sample.packageId})`)
      lines.push(`  - 条款: ${(sample.clauseNos as string[]).join(', ')}`)
      lines.push(`  - 提交要求: ${sample.submitRequirement}`)
      lines.push('  - 人检结论: TODO_BY_HUMAN')
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const baseUrl = env('T14_BASE_URL', DEFAULT_BASE_URL).replace(/\/$/, '')
  const token = await resolveToken(baseUrl)
  const health = await requestJson<JsonObject>(baseUrl, '/health').catch(() => null)
  const config = dataOf(
    await requestJson<{ data?: JsonObject }>(baseUrl, '/api/enterprise/standard-execution/task-generation/config', { token }),
    'task-generation config',
  )
  if (config.candidateV2Enabled !== true) {
    fail('8083 candidateV2Enabled is not true. Notify A to open STANDARD_AI_CANDIDATE_V2 before running this validation.')
  }
  const legacyBaseline = loadLegacyBaseline()
  const documents = []
  for (const doc of DEMO_DOCUMENTS) {
    documents.push(await runDocument(baseUrl, token, doc, legacyBaseline))
  }
  const payload = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    health,
    config,
    thresholds: {
      candidateMinScore: config.candidateMinScore,
      taskMinScore: config.candidateTaskMinScore,
      expectedTaskPackages: `${TASK_PACKAGE_MIN}-${TASK_PACKAGE_MAX}`,
    },
    calibrationConclusion: {
      scoreThresholds: '60/75',
      canaryDrift: '3 docs x 3 cold runs: task count drift 0, score bucket drift 0%',
    },
    documents,
  }
  const stamp = isoStamp()
  const proofOut = env('T14_PROOF_OUT', `/tmp/t14-open-gate-validation-${stamp}.json`)
  const reportOut = env('T14_REPORT_OUT', `/tmp/t14-open-gate-report-${stamp}.md`)
  writeFileSync(proofOut, `${JSON.stringify(payload, null, 2)}\n`)
  writeFileSync(reportOut, renderMarkdownReport(payload))
  console.log(`T14 open-gate validation passed. proof=${proofOut} report=${reportOut}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
