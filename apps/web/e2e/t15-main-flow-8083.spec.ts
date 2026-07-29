import { expect, request as requestFactory, test, type APIRequestContext } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const baseURL = process.env.E2E_BASE_URL || 'http://154.8.197.13:8083'
const adminToken = process.env.E2E_ADMIN_TOKEN || ''
const expectedCommit = process.env.E2E_EXPECT_COMMIT || 'e548a9f30e541d2375f942fd63a53e0adf661f2a'
const employeeToken = process.env.E2E_EMPLOYEE_TOKEN || ''
const employeePhone = process.env.E2E_EMPLOYEE_PHONE || process.env.T13_EMPLOYEE_PHONE || ''
const employeePassword = process.env.E2E_EMPLOYEE_PASSWORD || process.env.T13_EMPLOYEE_PASSWORD || ''
const appToken = process.env.E2E_APP_TOKEN || adminToken
const appPhone = process.env.E2E_APP_PHONE || ''
const appPassword = process.env.E2E_APP_PASSWORD || ''
const membershipToken = process.env.E2E_FREE_USER_TOKEN || process.env.E2E_MEMBERSHIP_TOKEN || ''
const membershipPhone = process.env.E2E_FREE_USER_PHONE || process.env.E2E_MEMBERSHIP_PHONE || ''
const membershipPassword = process.env.E2E_FREE_USER_PASSWORD || process.env.E2E_MEMBERSHIP_PASSWORD || ''
const runPrefix = process.env.E2E_RUN_PREFIX || `T15_MAIN_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`
const proofDir = process.env.E2E_PROOF_DIR || '/tmp'

type JsonObject = Record<string, unknown>

interface Source {
  id: string
  title: string
}

interface PreviewJob {
  id: string
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  result?: PreviewResult | null
  error?: { message?: string } | null
}

interface PreviewResult {
  parseMode?: string
  degraded?: boolean
  candidateV2Enabled?: boolean
  drafts?: Draft[]
  taskCards?: unknown[]
  taskPackages?: Array<{ packageId?: string; title?: string; clauseRefs?: string[] }>
  coverageReport?: { totalCandidates?: number; taskPackageCount?: number; entries?: Array<{ sourceText?: string; destination?: string; packageId?: string | null }> }
}

interface Draft {
  draftId?: string
  groupId?: string | null
  clauseNo?: string | null
  title: string
  requirementText: string
  recommendedTaskType?: string | null
  executionDescription?: string | null
  submitRequirement?: string | null
  requiredMaterials?: string[] | null
  taskDrafts?: Array<{
    taskDraftId?: string
    groupId?: string | null
    title?: string | null
    description?: string | null
    taskType?: string | null
    submitRequirement?: string | null
  }>
}

interface Member {
  id: string
  phone?: string | null
  nickName?: string | null
  name?: string | null
}

interface TaskItem {
  id: string
  status: string
  requirement?: { title?: string | null; clauseNo?: string | null }
}

interface ReviewSubmission {
  id?: string
  taskId?: string
  status?: string
  submission?: { id?: string; taskId?: string; status?: string }
  task?: { id?: string; title?: string }
}

interface ReviewDetail {
  submission: {
    id: string
    status: string
    submitDataJson?: {
      items?: unknown[]
      t15RegressionMarker?: string
      perRequirement?: Array<{
        taskItemId: string
        structuredFields?: Record<string, unknown>
        quiz?: Record<string, unknown>
      }>
    } | null
  }
}

interface RecordItem {
  id: string
  taskId?: string
  title?: string
}

interface StepProof {
  step: number
  name: string
  ok: boolean
  details?: JsonObject
}

function decodeSub(jwt: string): string {
  const body = jwt.split('.')[1]
  if (!body) return ''
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { sub?: string }
    return parsed.sub || ''
  } catch {
    return ''
  }
}

async function authedRequest(token: string): Promise<APIRequestContext> {
  return requestFactory.newContext({
    baseURL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${token}`,
    },
  })
}

async function readJson<T>(res: Awaited<ReturnType<APIRequestContext['fetch']>>, label: string): Promise<T> {
  const text = await res.text()
  let json: unknown
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`${label} returned non-JSON status=${res.status()} body=${text.slice(0, 300)}`)
  }
  if (!res.ok()) {
    throw new Error(`${label} failed status=${res.status()} body=${JSON.stringify(json).slice(0, 600)}`)
  }
  return json as T
}

async function appAuthContext(opts: { token?: string; phone?: string; password?: string; label: string }): Promise<{ api: APIRequestContext; token: string; userId: string; authMode: 'token' | 'password' }> {
  if (opts.token) {
    return { api: await authedRequest(opts.token), token: opts.token, userId: decodeSub(opts.token), authMode: 'token' }
  }
  if (!opts.phone || !opts.password) throw new Error(`Set ${opts.label} token or phone/password env`)
  const loginApi = await requestFactory.newContext({
    baseURL,
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
  })
  const res = await loginApi.post('/api/app/auth/login', {
    data: { account: opts.phone, password: opts.password },
  })
  const json = await readJson<{ data?: { token?: string }; token?: string }>(res, `${opts.label} password login`)
  await loginApi.dispose()
  const token = json.data?.token || json.token || ''
  if (!token) throw new Error(`${opts.label} password login did not return token`)
  return { api: await authedRequest(token), token, userId: decodeSub(token), authMode: 'password' }
}

async function employeeAuthContext(): Promise<{ api: APIRequestContext; token: string; userId: string }> {
  if (employeeToken) {
    return { api: await authedRequest(employeeToken), token: employeeToken, userId: decodeSub(employeeToken) }
  }
  if (!employeePhone || !employeePassword) throw new Error('Set E2E_EMPLOYEE_TOKEN or E2E_EMPLOYEE_PHONE/E2E_EMPLOYEE_PASSWORD')
  const loginApi = await requestFactory.newContext({
    baseURL,
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
  })
  const res = await loginApi.post('/api/app/auth/login', {
    data: { account: employeePhone, password: employeePassword },
  })
  const json = await readJson<{ data?: { token?: string }; token?: string }>(res, 'employee login')
  await loginApi.dispose()
  const token = json.data?.token || json.token || ''
  if (!token) throw new Error('employee login did not return token')
  return { api: await authedRequest(token), token, userId: decodeSub(token) }
}

function securityDemoText(prefix: string): string {
  return [
    `${prefix} 1. 门岗人员应在每日早班前完成岗位交接，核对访客登记簿、钥匙柜和对讲设备状态，并提交交接班记录。`,
    '2. 巡逻人员应按园区巡更路线每两小时完成一次巡查，发现消防通道堵塞、围栏破损或可疑滞留人员时记录位置、照片和处置结果。',
    '3. 监控室值班员应持续关注重点区域视频，异常事件应在十分钟内通知现场人员并形成监控处置记录。',
    '4. 押运交接应由两名以上人员共同核对封签、数量和交接单，交接异常必须立即报告主管并留存复核意见。',
    '5. 安保主管应每周抽查门岗登记、巡逻签到和监控处置记录，抽查结论应形成整改清单并跟踪闭环。',
    '6. 新入职保安员上岗前应完成岗位职责、突发事件处置和客户现场纪律培训，考核合格后方可独立上岗。',
    '7. 外来施工人员进入重点区域前应核验审批单、身份证明和陪同人员信息，离场时应复核工具材料清单。',
    '8. 夜间巡逻应重点检查配电间、消防泵房和客户资料室门禁状态，异常开门记录应在当班内完成复核。',
    '9. 突发事件处置结束后，现场负责人应汇总事件时间线、人员分工、照片证据和客户确认意见。',
    '10. 月度安保服务复盘应统计迟到漏巡、客户投诉、整改完成率和培训覆盖率，并提交管理层评审。',
  ].join('\n')
}

function personalCompareText(prefix: string): string {
  const clauses = [
    '门岗人员应核对访客登记、车辆出入凭证和临时通行证，异常信息必须在当班内报告主管。',
    '巡逻人员应按照规定路线检查消防通道、配电间、监控盲区和客户资料室门禁状态，并保存巡更签到记录。',
    '交接班人员应共同核对钥匙柜、对讲设备、未结事项和客户特别要求，双方签字确认后方可离岗。',
    '监控室值班员发现重点区域异常停留、夜间开门或设备离线时，应立即通知现场人员复核并登记处置结果。',
    '安保主管应每周抽查门岗登记、巡逻记录、监控处置记录和整改闭环清单，形成复盘报告。',
    '新入职保安员应完成岗位职责、突发事件处置、客户服务纪律和证据留存培训，考核合格后上岗。',
  ]
  return Array.from({ length: 5 }, (_, round) =>
    clauses.map((clause, index) => `${prefix}-${round + 1}.${index + 1} ${clause}`).join('\n'),
  ).join('\n\n')
}

async function createSource(api: APIRequestContext): Promise<Source> {
  const res = await api.post('/api/enterprise/standard-execution/sources', {
    data: {
      title: `${runPrefix} 安保主链路验收标准`,
      sourceType: 'PRODUCT_STANDARD',
      sourceNo: runPrefix,
      version: '2026-T15',
      rawText: securityDemoText(runPrefix),
    },
  })
  const json = await readJson<{ data: Source }>(res, 'create source')
  return json.data
}

async function findEmployee(api: APIRequestContext, userId: string): Promise<Member> {
  const res = await api.get('/api/enterprise/members')
  const json = await readJson<{ data: Member[] }>(res, 'list enterprise members')
  const byUser = json.data.find((m) => m.id === userId)
  const byPhone = employeePhone ? json.data.find((m) => m.phone === employeePhone) : null
  if (employeeToken && !byUser) {
    throw new Error(`E2E_EMPLOYEE_TOKEN subject is not an enterprise member: ${userId}`)
  }
  const fallback = json.data.find((m) => m.id && m.phone) || json.data[0]
  const member = byUser || byPhone || fallback
  if (!member?.id) throw new Error('No enterprise member available for employee flow')
  return member
}

async function startAndWaitPreview(api: APIRequestContext, sourceId: string): Promise<PreviewResult> {
  const started = await api.post('/api/enterprise/standard-execution/task-generation/preview/jobs', {
    data: { sourceId, parseMode: 'OCR_AI', polish: { enabled: true, target: 'TASK_CARD_V2' } },
  })
  const startJson = await readJson<{ data: PreviewJob }>(started, 'start preview job')
  const jobId = startJson.data.id
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const res = await api.get(`/api/enterprise/standard-execution/task-generation/preview/jobs/${jobId}`)
    const json = await readJson<{ data: PreviewJob }>(res, 'get preview job')
    if (json.data.status === 'FAILED') throw new Error(`preview job failed: ${json.data.error?.message || 'unknown'}`)
    if (json.data.status === 'SUCCEEDED' && json.data.result) return json.data.result
  }
  throw new Error(`preview job timed out: ${jobId}`)
}

async function waitForCompareCompleted(api: APIRequestContext, taskNo: string) {
  const deadline = Date.now() + 5 * 60_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000))
    const res = await api.get(`/api/app/compare/tasks/${taskNo}/status`)
    const json = await readJson<{ taskNo: string; status: string; errorMessage?: string }>(res, 'get compare task status')
    if (json.status === 'FAILED') throw new Error(`compare task failed: ${json.errorMessage || 'unknown'}`)
    if (json.status === 'COMPLETED') return json
  }
  throw new Error(`compare task timed out: ${taskNo}`)
}

async function commitFirstPackage(api: APIRequestContext, sourceId: string, preview: PreviewResult, employeeId: string, reviewerId: string) {
  const drafts = preview.drafts || []
  expect(drafts.length, 'preview drafts').toBeGreaterThan(0)
  const selectedDrafts = drafts.slice(0, 3)
  const selectedCardIds = selectedDrafts.flatMap((draft) =>
    draft.taskDrafts?.map((taskDraft) => taskDraft.taskDraftId).filter(Boolean) || [],
  ) as string[]
  const res = await api.post('/api/enterprise/standard-execution/task-generation/commit', {
    data: {
      sourceId,
      parseMode: preview.parseMode || 'OCR_AI',
      taskStatus: 'PENDING_APPROVAL',
      titlePrefix: runPrefix,
      deadlineMode: 'AFTER_APPROVAL_DAYS',
      deadlineDaysAfterApproval: 7,
      reviewerId,
      assigneeIds: [employeeId],
      cardIds: selectedCardIds.length ? selectedCardIds : undefined,
      drafts: selectedDrafts,
    },
  })
  const json = await readJson<{ data: { created: { requirementIds: string[]; taskIds: string[] }; summary: { requirements: number; tasks: number } } }>(res, 'commit task generation')
  expect(json.data.created.taskIds.length, 'created task ids').toBeGreaterThan(0)
  return json.data
}

async function findSubmission(api: APIRequestContext, taskId: string): Promise<ReviewSubmission> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const res = await api.get('/api/enterprise/standard-execution/reviews', {
      params: { pageSize: '100', status: 'SUBMITTED' },
    })
    const json = await readJson<{ data: ReviewSubmission[] }>(res, 'list reviews')
    const submission = json.data.find((item) => item.taskId === taskId || item.submission?.taskId === taskId || item.task?.id === taskId)
    if (submission?.id || submission?.submission?.id) return submission
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`submission not found for task ${taskId}`)
}

function assertCoverage(preview: PreviewResult) {
  expect(preview.candidateV2Enabled, 'candidate v2 enabled').toBe(true)
  expect(preview.degraded, 'preview degraded').toBe(false)
  const packages = preview.taskPackages || []
  expect(packages.length, 'task packages 8-12').toBeGreaterThanOrEqual(8)
  expect(packages.length, 'task packages 8-12').toBeLessThanOrEqual(12)
  expect(preview.coverageReport?.entries?.length || 0, 'coverage entries').toBeGreaterThanOrEqual(8)
  const uncovered = preview.coverageReport?.entries?.filter((entry) => !entry.destination) || []
  expect(uncovered, 'all coverage entries have destination').toHaveLength(0)
}

test.describe('T15-1 8083 main execution flow', () => {
  test.skip(!adminToken, 'Set E2E_ADMIN_TOKEN to run T15-1 main-flow E2E')
  test.skip(!employeeToken && (!employeePhone || !employeePassword), 'Set employee token or phone/password env to run T15-1 main-flow E2E')

  test('covers document, extraction, task, dispatch, employee submit, review, record, package, and risk regression', async () => {
    test.setTimeout(10 * 60 * 1000)

    const steps: StepProof[] = []
    const proof = {
      runPrefix,
      baseURL,
      expectedCommit,
      startedAt: new Date().toISOString(),
      steps,
      ids: {} as JsonObject,
    }
    const recordStep = (step: number, name: string, details?: JsonObject) => {
      steps.push({ step, name, ok: true, details })
    }

    const adminApi = await authedRequest(adminToken)
    const employeeAuth = await employeeAuthContext()
    const employeeApi = employeeAuth.api
    try {
      const health = await readJson<{ ok?: boolean; commit?: string }>(await adminApi.get('/health'), 'health')
      expect(health.ok).toBe(true)
      expect(health.commit).toBe(expectedCommit)
      const config = await readJson<{ data: { candidateV2Enabled?: boolean; candidateMinScore?: number; candidateTaskMinScore?: number } }>(
        await adminApi.get('/api/enterprise/standard-execution/task-generation/config'),
        'task generation config',
      )
      expect(config.data.candidateV2Enabled).toBe(true)
      recordStep(1, '8083 baseline and candidate v2 gate', { commit: health.commit, thresholds: config.data })

      const employee = await findEmployee(adminApi, employeeAuth.userId)
      proof.ids.employeeId = employee.id
      recordStep(2, 'real employee account resolved', { employeeId: employee.id })

      const source = await createSource(adminApi)
      proof.ids.sourceId = source.id
      recordStep(3, 'document source created', { sourceId: source.id, title: source.title })

      const preview = await startAndWaitPreview(adminApi, source.id)
      assertCoverage(preview)
      const samplePackages = (preview.taskPackages || []).slice(0, 3).map((pkg) => ({
        packageId: pkg.packageId,
        title: pkg.title,
        clauseRefs: pkg.clauseRefs,
      }))
      recordStep(4, 'async AI extraction produced task packages and coverage report', {
        parseMode: preview.parseMode,
        taskPackageCount: preview.taskPackages?.length,
        coverageEntries: preview.coverageReport?.entries?.length,
        samplePackages,
      })

      const reviewerId = decodeSub(adminToken)
      expect(reviewerId, 'reviewer user id').toBeTruthy()
      const committed = await commitFirstPackage(adminApi, source.id, preview, employee.id, reviewerId)
      const taskId = committed.created.taskIds[0]
      proof.ids.taskId = taskId
      proof.ids.requirementIds = committed.created.requirementIds
      recordStep(5, 'task generated and assigned for approval', {
        taskId,
        createdTasks: committed.created.taskIds.length,
        createdRequirements: committed.created.requirementIds.length,
      })

      const approvedTask = await readJson<{ data: { id: string; status: string; deadlineAt?: string | null } }>(
        await adminApi.post(`/api/enterprise/standard-execution/tasks/${taskId}/approval/approve`, {
          data: { comment: `${runPrefix} 自动化审核通过，进入员工执行。` },
        }),
        'approve task dispatch',
      )
      expect(approvedTask.data.status).toBe('PUBLISHED')
      recordStep(6, 'task approval passed and dispatched', { taskId, status: approvedTask.data.status, deadlineAt: approvedTask.data.deadlineAt })

      const employeeTask = await readJson<{ data: { task: { id: string; status: string }; myAssignee: { status: string } } }>(
        await employeeApi.get(`/api/app/standard-execution/tasks/${taskId}`),
        'employee task detail',
      )
      expect(employeeTask.data.task.id).toBe(taskId)
      await readJson<{ data: { status: string } }>(
        await employeeApi.post(`/api/app/standard-execution/tasks/${taskId}/view`, { data: {} }),
        'employee view task',
      )
      recordStep(7, 'employee can open task and start execution', {
        taskId,
        taskStatus: employeeTask.data.task.status,
        assigneeStatus: employeeTask.data.myAssignee.status,
      })

      const itemsJson = await readJson<{ data: TaskItem[] }>(
        await employeeApi.get(`/api/app/standard-execution/tasks/${taskId}/items`),
        'employee task items',
      )
      for (const item of itemsJson.data) {
        await readJson<{ data: TaskItem }>(
          await employeeApi.patch(`/api/app/standard-execution/tasks/${taskId}/items/${item.id}`, {
            data: {
              status: 'DONE',
              note: `${runPrefix} ${item.requirement?.clauseNo || ''} 已完成现场核验并留痕。`,
              fileUrls: [`/uploads/e2e/${runPrefix}/${item.id}.txt`],
            },
          }),
          'complete task item',
        )
      }
      recordStep(8, 'employee execution items completed', { taskId, itemCount: itemsJson.data.length })

      const perRequirementSubmitData = itemsJson.data.map((item, index) => ({
        taskItemId: item.id,
        requirementTitle: item.requirement?.title || null,
        structuredFields: {
          patrolLocation: index === 0 ? '东门岗' : `巡更点-${index + 1}`,
          checkedAt: `${runPrefix}-WORKDAY-09${index}:30`,
          result: '已核验',
        },
        quiz: {
          questionId: `${runPrefix}-quiz-${index + 1}`,
          selected: ['A'],
          passed: true,
        },
      }))
      const submitDataJson = {
        t15RegressionMarker: `${runPrefix}-submitDataJson-preserved`,
        perRequirement: perRequirementSubmitData,
      }
      const submit = await readJson<{ data: { id: string; status: string; attachments?: unknown[] } }>(
        await employeeApi.post(`/api/app/standard-execution/tasks/${taskId}/submit`, {
          data: {
            submitText: `${runPrefix} 员工已完成门岗、巡逻和复盘要求，提交自动化验收记录。`,
            submitDataJson,
            attachments: [{
              fileName: `${runPrefix}-巡更签到表.txt`,
              fileUrl: `/uploads/e2e/${runPrefix}/patrol-signin.txt`,
              fileSize: 128,
              mimeType: 'text/plain',
            }],
          },
        }),
        'employee submit task',
      )
      proof.ids.submissionId = submit.data.id
      expect(submit.data.status).toBe('SUBMITTED')
      recordStep(9, 'employee submitted task evidence', { submissionId: submit.data.id, attachmentCount: submit.data.attachments?.length || 0 })

      const submission = await findSubmission(adminApi, taskId)
      const submissionId = submission.id || submission.submission?.id
      expect(submissionId, 'review submission id').toBeTruthy()
      const reviewDetail = await readJson<{ data: ReviewDetail }>(
        await adminApi.get(`/api/enterprise/standard-execution/reviews/${submissionId}`),
        'review detail with submitDataJson',
      )
      const persistedSubmitData = reviewDetail.data.submission.submitDataJson
      expect(persistedSubmitData?.t15RegressionMarker, 'submitDataJson marker is preserved').toBe(submitDataJson.t15RegressionMarker)
      expect(persistedSubmitData?.perRequirement?.length, 'per-requirement submit data is preserved').toBe(perRequirementSubmitData.length)
      expect(persistedSubmitData?.perRequirement?.[0]?.structuredFields?.result, 'structured field result is readable').toBe('已核验')
      expect(persistedSubmitData?.perRequirement?.[0]?.quiz?.passed, 'quiz payload is readable').toBe(true)
      expect(persistedSubmitData?.items?.length, 'task item progress snapshot is still present').toBe(itemsJson.data.length)
      const review = await readJson<{ data: { submission: { id: string; status: string }; records: Array<{ id: string }>; taskCompleted: boolean } }>(
        await adminApi.post(`/api/enterprise/standard-execution/reviews/${submissionId}/approve`, {
          data: {
            reviewComment: `${runPrefix} 审核通过，记录真实完整。`,
            recordTitle: `${runPrefix} 安保执行验收记录`,
            recordSummary: `${runPrefix} 门岗交接、巡逻检查、监控处置与月度复盘记录已核验。`,
          },
        }),
        'approve submission',
      )
      expect(review.data.submission.status).toBe('APPROVED')
      expect(review.data.records.length, 'created records').toBeGreaterThan(0)
      const recordIds = review.data.records.map((record) => record.id)
      proof.ids.recordIds = recordIds
      recordStep(10, 'review approved and execution records created', {
        submissionId,
        recordCount: recordIds.length,
        taskCompleted: review.data.taskCompleted,
        submitDataJsonMarker: persistedSubmitData?.t15RegressionMarker,
        perRequirementSubmitDataCount: persistedSubmitData?.perRequirement?.length,
      })

      const records = await readJson<{ data: RecordItem[]; total?: number }>(
        await adminApi.get('/api/enterprise/standard-execution/records', {
          params: { taskId, pageSize: '50' },
        }),
        'list records',
      )
      expect(records.data.length, 'record pool task records').toBeGreaterThanOrEqual(recordIds.length)
      const packageCreate = await readJson<{ data: { id: string; title: string; status: string } }>(
        await adminApi.post('/api/enterprise/standard-execution/packages', {
          data: {
            title: `${runPrefix} 客户审计材料包`,
            packageScene: 'CUSTOMER_AUDIT',
            description: 'T15-1 主链路 E2E 自动生成材料包。',
            format: 'FOLDER',
            recordIds,
          },
        }),
        'create package',
      )
      proof.ids.packageId = packageCreate.data.id
      const packagePreview = await readJson<{ data: { stats: { recordCount: number; taskCount: number; attachmentCount: number }; outputFileTree: unknown[] } }>(
        await adminApi.post(`/api/enterprise/standard-execution/packages/${packageCreate.data.id}/preview`, {
          data: { includeManifest: true, includeAuditTrace: true, includeBasisClauses: true, includeStatisticsSummary: true },
        }),
        'preview package',
      )
      expect(packagePreview.data.stats.recordCount).toBeGreaterThanOrEqual(recordIds.length)
      const generatedPackage = await readJson<{ data?: { id: string; generationStatus?: string | null }; status?: string; outputFiles?: unknown[] }>(
        await adminApi.post(`/api/enterprise/standard-execution/packages/${packageCreate.data.id}/generate`, {
          data: { includeManifest: true, includeAuditTrace: true, includeBasisClauses: true, includeStatisticsSummary: true },
        }),
        'generate package',
      )
      recordStep(11, 'record pool package generated and risk endpoint checked', {
        listedRecords: records.data.length,
        packageId: packageCreate.data.id,
        packageRecordCount: packagePreview.data.stats.recordCount,
        packageTaskCount: packagePreview.data.stats.taskCount,
        packageAttachmentCount: packagePreview.data.stats.attachmentCount,
        packageGenerationStatus: generatedPackage.data?.generationStatus || generatedPackage.status,
        outputFileCount: generatedPackage.outputFiles?.length,
      })

      const risks = await readJson<{ data: Array<{ id: string; riskType: string; riskLevel: string }>; total?: number }>(
        await adminApi.get('/api/enterprise/standard-execution/risks'),
        'list risks',
      )
      expect(Array.isArray(risks.data)).toBe(true)
      steps[steps.length - 1].details = { ...(steps[steps.length - 1].details || {}), riskCount: risks.data.length, riskSample: risks.data.slice(0, 3) }

      proof.ids.previewTaskPackageCount = preview.taskPackages?.length
      proof.ids.previewCoverageEntries = preview.coverageReport?.entries?.length
      proof.finishedAt = new Date().toISOString()
      mkdirSync(proofDir, { recursive: true })
      const proofPath = join(proofDir, `t15-main-flow-8083-${runPrefix}.json`)
      writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`)
      test.info().annotations.push({ type: 'proof', description: proofPath })
    } finally {
      await adminApi.dispose()
      await employeeApi.dispose()
    }
  })
})

test.describe('T15-1 8083 personal edition golden flows', () => {
  test.skip(!appToken && (!appPhone || !appPassword), 'Set E2E_APP_TOKEN/E2E_ADMIN_TOKEN or E2E_APP_PHONE/E2E_APP_PASSWORD to run personal standard/compare E2E')

  test('covers login token, standard search, detail, compare submit, and report visibility', async () => {
    test.setTimeout(7 * 60 * 1000)

    const auth = await appAuthContext({ token: appToken, phone: appPhone, password: appPassword, label: 'personal app user' })
    const api = auth.api
    try {
      const health = await readJson<{ ok?: boolean; commit?: string }>(await api.get('/health'), 'health')
      expect(health.ok).toBe(true)
      expect(health.commit).toBe(expectedCommit)

      const profile = await readJson<{ user?: { id?: string; phone?: string | null }; membership?: { plan?: { id?: string } } | null }>(
        await api.get('/api/app/profile'),
        'app profile',
      )
      expect(profile.user?.id, 'app user id').toBeTruthy()

      const standards = await readJson<{ total: number; items: Array<{ id: string; code: string; title: string }> }>(
        await api.get('/api/app/standards', { params: { keyword: '安全' } }),
        'standard search',
      )
      expect(standards.total, 'standard search total').toBeGreaterThan(0)
      const standard = standards.items[0]
      const detail = await readJson<{ id: string; code: string; title: string; actions?: { canCompare?: boolean } }>(
        await api.get(`/api/app/standards/${encodeURIComponent(standard.id)}`),
        'standard detail',
      )
      expect(detail.id).toBe(standard.id)
      expect(detail.actions?.canCompare).toBe(true)

      const compare = await api.post('/api/app/compare/library', {
        multipart: {
          file: {
            name: `${runPrefix}-personal-compare.txt`,
            mimeType: 'text/plain',
            buffer: Buffer.from(personalCompareText(runPrefix), 'utf8'),
          },
          documentName: `${runPrefix}-个人版标准比对.txt`,
          title: `${runPrefix} 个人版标准比对`,
        },
      })
      const compareJson = await readJson<{ taskNo: string; status: string }>(compare, 'create compare task')
      expect(compareJson.taskNo, 'compare taskNo').toBeTruthy()
      await waitForCompareCompleted(api, compareJson.taskNo)

      const report = await readJson<{
        taskNo: string
        status: string
        documentName: string
        compareMode: string
        access?: { fullReportUnlocked?: boolean }
        preview?: unknown
        report?: unknown
      }>(
        await api.get(`/api/app/compare/tasks/${compareJson.taskNo}`),
        'compare report',
      )
      expect(report.taskNo).toBe(compareJson.taskNo)
      expect(report.status).toBe('COMPLETED')
      expect(report.compareMode).toBe('library')
      expect(report.preview || report.report, 'compare report preview/full content').toBeTruthy()

      mkdirSync(proofDir, { recursive: true })
      const proofPath = join(proofDir, `t15-personal-compare-8083-${runPrefix}.json`)
      writeFileSync(proofPath, `${JSON.stringify({
        runPrefix,
        baseURL,
        expectedCommit,
        userId: profile.user?.id,
        authMode: auth.authMode,
        membershipPlan: profile.membership?.plan?.id || 'free',
        standard: { id: detail.id, code: detail.code, title: detail.title },
        compare: {
          taskNo: report.taskNo,
          status: report.status,
          compareMode: report.compareMode,
          fullReportUnlocked: report.access?.fullReportUnlocked ?? false,
          hasPreview: !!report.preview,
          hasReport: !!report.report,
        },
        finishedAt: new Date().toISOString(),
      }, null, 2)}\n`)
      test.info().annotations.push({ type: 'proof', description: proofPath })
    } finally {
      await api.dispose()
    }
  })

  test('covers membership order with mock payment and order visibility', async () => {
    test.skip(!membershipToken && (!membershipPhone || !membershipPassword), 'Set E2E_FREE_USER_TOKEN/E2E_MEMBERSHIP_TOKEN or E2E_FREE_USER_PHONE/E2E_FREE_USER_PASSWORD for membership purchase E2E')
    test.setTimeout(2 * 60 * 1000)

    const auth = await appAuthContext({ token: membershipToken, phone: membershipPhone, password: membershipPassword, label: 'free membership user' })
    const api = auth.api
    try {
      const before = await readJson<{ currentMembership?: { plan?: { id?: string } } | null; plans: Array<{ id: string; name: string; priceUnit: number }> }>(
        await api.get('/api/app/membership/plans'),
        'membership plans',
      )
      const currentPlan = before.currentMembership?.plan?.id || 'free'
      test.skip(currentPlan !== 'free', `membership purchase E2E needs a free user, current plan is ${currentPlan}`)
      const plan = before.plans.find((item) => item.id === 'personal')
      expect(plan, 'personal membership plan').toBeTruthy()

      const order = await readJson<{ orderNo: string; status: string; productType: string; planId: string; amount: number }>(
        await api.post('/api/app/orders', {
          data: {
            productType: 'MEMBERSHIP',
            planId: 'personal',
            title: plan!.name,
            amount: plan!.priceUnit,
            channel: 'ALIPAY',
            payload: { source: 'T15-1 membership mock payment E2E' },
          },
        }),
        'create membership order',
      )
      expect(order.orderNo).toBeTruthy()
      expect(order.productType).toBe('MEMBERSHIP')

      const paid = await readJson<{ orderNo: string; status: string; payMode?: string }>(
        await api.post(`/api/app/orders/${order.orderNo}/pay`, { data: { channel: 'ALIPAY' } }),
        'mock pay membership order',
      )
      expect(paid.status).toBe('PAID')

      const status = await readJson<{ orderNo: string; status: string; paidAt?: string }>(
        await api.get(`/api/app/orders/${order.orderNo}/status`),
        'membership order status',
      )
      expect(status.status).toBe('PAID')
      expect(status.paidAt).toBeTruthy()

      const profile = await readJson<{ membership?: { status?: string; plan?: { id?: string } } | null }>(
        await api.get('/api/app/profile'),
        'post payment profile',
      )
      expect(profile.membership?.status).toBe('ACTIVE')
      expect(profile.membership?.plan?.id).toBe('personal')

      const orders = await readJson<{ items: Array<{ orderNo: string; status: string; productType: string; planId?: string | null }> }>(
        await api.get('/api/app/orders'),
        'list orders after membership payment',
      )
      const visible = orders.items.find((item) => item.orderNo === order.orderNo)
      expect(visible?.status).toBe('PAID')
      expect(visible?.productType).toBe('MEMBERSHIP')

      mkdirSync(proofDir, { recursive: true })
      const proofPath = join(proofDir, `t15-membership-order-8083-${runPrefix}.json`)
      writeFileSync(proofPath, `${JSON.stringify({
        runPrefix,
        baseURL,
        expectedCommit,
        userId: auth.userId,
        authMode: auth.authMode,
        orderNo: order.orderNo,
        productType: visible?.productType,
        planId: visible?.planId,
        orderStatus: visible?.status,
        membershipPlan: profile.membership?.plan?.id,
        paidAt: status.paidAt,
        paymentChannel: 'ALIPAY_MOCK',
        finishedAt: new Date().toISOString(),
      }, null, 2)}\n`)
      test.info().annotations.push({ type: 'proof', description: proofPath })
    } finally {
      await api.dispose()
    }
  })
})
