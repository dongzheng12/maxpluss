import { expect, request as requestFactory, test, type APIRequestContext, type Page } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL || 'http://154.8.197.13:8083'
const token = process.env.E2E_ADMIN_TOKEN || ''
const expectedCommit = process.env.E2E_EXPECT_COMMIT || 'ec65af1'
const runPrefix = process.env.E2E_RUN_PREFIX || `E2E_8083_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`

interface Source {
  id: string
  title: string
  sourceNo?: string | null
}

interface Member {
  id: string
  phone: string
  nickName?: string | null
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

async function authedRequest(): Promise<APIRequestContext> {
  return requestFactory.newContext({
    baseURL,
    extraHTTPHeaders: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
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
    throw new Error(`${label} failed status=${res.status()} body=${JSON.stringify(json).slice(0, 500)}`)
  }
  return json as T
}

async function prepareSource(api: APIRequestContext): Promise<Source> {
  if (process.env.E2E_SOURCE_ID) {
    const res = await api.get(`/api/enterprise/standard-execution/sources?status=ACTIVE&pageSize=500`)
    const json = await readJson<{ data: Source[] }>(res, 'list sources')
    const existing = json.data.find((s) => s.id === process.env.E2E_SOURCE_ID)
    if (!existing) throw new Error(`E2E_SOURCE_ID not found: ${process.env.E2E_SOURCE_ID}`)
    return existing
  }

  const body = {
    title: `${runPrefix} v2 工作台全量验收标准`,
    sourceType: 'PRODUCT_STANDARD',
    sourceNo: runPrefix,
    version: '2026',
    rawText: [
      '1.1 应建立年度培训制度，明确培训计划、签到记录、考核结果和改进要求。',
      '1.2 应每季度检查执行记录，发现缺项时形成整改台账并跟踪关闭。',
      '1.3 应按月归档培训、检查、整改和复盘材料，确保材料可追溯。',
      '1.4 应指定审核人与执行人，对任务完成情况进行复核并保留证据。',
    ].join('\n'),
  }
  const res = await api.post('/api/enterprise/standard-execution/sources', { data: body })
  const json = await readJson<{ data: Source }>(res, 'create source')
  return json.data
}

async function firstMember(api: APIRequestContext): Promise<Member> {
  const res = await api.get('/api/enterprise/members')
  const json = await readJson<{ data: Member[] }>(res, 'list enterprise members')
  const member = json.data.find((m) => m.id && m.phone) || json.data[0]
  if (!member) throw new Error('No enterprise member available for dispatch reviewer/assignee')
  return member
}

async function seedAuth(page: Page, userId: string) {
  await page.addInitScript(
    ({ jwt, uid }) => {
      localStorage.setItem('bxz_token', jwt)
      localStorage.setItem('bxz_user_id', uid)
      localStorage.setItem('bxz_user', JSON.stringify({ id: uid, role: 'admin', phone: 'e2e-8083' }))
      localStorage.setItem('poc_access_ok', 'true')
      localStorage.setItem('poc_access_expire_at', String(Date.now() + 7 * 24 * 60 * 60 * 1000))
    },
    { jwt: token, uid: userId },
  )
}

async function visibleCardCount(page: Page): Promise<number> {
  await expect(page.locator('[data-card-id]').first()).toBeVisible({ timeout: 120_000 })
  return page.locator('[data-card-id]').count()
}

type PreviewResponseData = {
  taskCards?: unknown[]
  status?: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'
  result?: { taskCards?: unknown[] } | null
  error?: { message?: string } | null
}

async function waitForPreviewResult(page: Page): Promise<{ taskCards: unknown[] }> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 150_000) {
    const response = await page.waitForResponse((res) =>
      res.url().includes('/api/enterprise/standard-execution/task-generation/preview') &&
      res.status() < 300,
    { timeout: 150_000 - (Date.now() - startedAt) })
    const json = await response.json() as { data?: PreviewResponseData }
    const data = json.data
    if (data?.taskCards?.length) return { taskCards: data.taskCards }
    if (data?.status === 'SUCCEEDED' && data.result?.taskCards?.length) return { taskCards: data.result.taskCards }
    if (data?.status === 'FAILED') throw new Error(`Async preview job failed: ${data.error?.message || 'unknown error'}`)
  }
  throw new Error('Timed out waiting for preview task cards')
}

async function setCardChecked(page: Page, index: number, checked: boolean) {
  const card = page.locator('[data-card-id]').nth(index)
  const input = card.locator('.ant-checkbox-input').first()
  if (await input.isChecked() === checked) return
  await card.getByRole('checkbox').click()
  await expect.poll(async () => input.isChecked()).toBe(checked)
}

async function checkCard(page: Page, index: number) {
  await setCardChecked(page, index, true)
}

async function selectInAntdDropdown(page: Page, modal: ReturnType<Page['locator']>, index: number, query: string) {
  const select = modal.locator('.ant-select').nth(index)
  await select.click()
  await page.keyboard.type(query)
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden):not(.ant-slide-up-leave):not(.ant-slide-up-leave-active)')
  await expect(dropdown).toBeVisible()
  const option = dropdown.getByText(query, { exact: false })
  await expect(option).toHaveCount(1)
  await option.click()
  await page.keyboard.press('Escape')
  await expect(dropdown).toBeHidden()
}

const twoCharButton = (text: string) => new RegExp(text.split('').join('\\s*'))

test.describe('8083 v2 workbench full acceptance', () => {
  test.skip(!token, 'Set E2E_ADMIN_TOKEN to run the 8083 full workbench E2E')

  test('covers generate, rewrite, repolish, re-extract, edit, split/merge, draft save, dispatch, and API verification', async ({ page }) => {
    test.setTimeout(7 * 60 * 1000)

    const userId = process.env.E2E_USER_ID || decodeSub(token)
    expect(userId, 'E2E user id').toBeTruthy()
    const api = await authedRequest()
    const source = await prepareSource(api)
    const member = await firstMember(api)

    const healthRes = await api.get('/health')
    const health = await readJson<{ commit?: string; ok?: boolean }>(healthRes, 'health')
    expect(health.ok).toBe(true)
    expect(health.commit).toBe(expectedCommit)

    await seedAuth(page, userId)
    await page.goto(`/enterprise/workbench?sourceId=${encodeURIComponent(source.id)}`)
    await expect(page.getByText('AI 任务草稿工作台')).toBeVisible()
    await expect(page.getByRole('button', { name: 'AI 生成任务草稿' })).toBeVisible()
    await expect(page.getByText('保存或派发')).toBeVisible()
    await expect(page.getByText(source.title, { exact: true })).toBeVisible({ timeout: 30_000 })

    const previewPromise = waitForPreviewResult(page)
    await page.getByRole('button', { name: 'AI 生成任务草稿' }).click()
    const previewJson = await previewPromise
    expect(previewJson.taskCards.length).toBeGreaterThan(0)
    const generatedCardCount = await visibleCardCount(page)
    expect(generatedCardCount).toBeGreaterThan(0)
    await expect(page.getByText(new RegExp(`已生成 ${generatedCardCount} 张`))).toBeVisible()

    await page.goto('/enterprise/dashboard')
    await expect(page.locator('[class*="topbarTitle"]').filter({ hasText: '执行总览' })).toBeVisible({ timeout: 30_000 })
    await page.goto(`/enterprise/workbench?sourceId=${encodeURIComponent(source.id)}`)
    expect(await visibleCardCount(page)).toBe(generatedCardCount)

    const firstCard = page.locator('[data-card-id]').first()
    const rewritePromise = page.waitForResponse((res) =>
      res.url().includes('/task-generation/card-rewrite') && res.request().method() === 'POST' && res.status() < 300,
    { timeout: 120_000 })
    await firstCard.getByRole('button', { name: 'AI 重写' }).click()
    await page.locator('.ant-modal').filter({ hasText: 'AI 重写会覆盖本卡当前内容' }).getByRole('button', { name: twoCharButton('重写') }).click()
    const rewriteJson = await (await rewritePromise).json()
    expect(rewriteJson.data.operation).toBe('CARD_REWRITE')
    await expect(page.getByRole('button', { name: '撤销重写' })).toBeVisible()
    await page.getByRole('button', { name: '撤销重写' }).click()
    await expect(page.getByText('已撤销重写')).toBeVisible()

    await checkCard(page, 0)
    const repolishPromise = page.waitForResponse((res) =>
      res.url().includes('/task-generation/cards/repolish') && res.request().method() === 'POST' && res.status() < 300,
    { timeout: 120_000 })
    await page.getByRole('button', { name: 'AI 优化' }).click()
    const repolishJson = await (await repolishPromise).json()
    expect(repolishJson.data.operation).toBe('BATCH_REPOLISH')
    expect(repolishJson.data.taskCards.length).toBeGreaterThan(0)

    const reextractPromise = page.waitForResponse((res) =>
      res.url().includes('/task-generation/re-extract') && res.request().method() === 'POST' && res.status() < 300,
    { timeout: 150_000 })
    await page.getByRole('button', { name: /整体重.*提取/ }).click()
    await page.locator('.ant-modal').filter({ hasText: /整体重.*提取/ }).getByRole('button', { name: '重新提取' }).click()
    const reextractJson = await (await reextractPromise).json()
    expect(reextractJson.data.operation).toBe('RE_EXTRACT')
    expect(await visibleCardCount(page)).toBeGreaterThan(0)

    const editableTitle = `${runPrefix} 编辑后任务卡`
    const editableCard = page.locator('[data-card-id]').first()
    await editableCard.getByRole('button', { name: '编辑' }).click()
    const editModal = page.locator('.ant-modal').filter({ hasText: '编辑任务卡' })
    await expect(editModal).toBeVisible()
    await editModal.getByLabel('任务标题').fill(editableTitle)
    await editModal.getByRole('button', { name: twoCharButton('保存') }).click()
    await expect(page.getByText(editableTitle)).toBeVisible()

    const beforeSplit = await page.locator('[data-card-id]').count()
    await page.locator('[data-card-id]').first().getByRole('button', { name: '拆分' }).click()
    await expect.poll(() => page.locator('[data-card-id]').count()).toBe(beforeSplit + 1)
    await checkCard(page, 0)
    await checkCard(page, 1)
    await page.getByRole('button', { name: '合并为一卡' }).click()
    await expect.poll(() => page.locator('[data-card-id]').count()).toBe(beforeSplit)

    await checkCard(page, 0)
    await page.getByRole('button', { name: '批量调截止' }).click()
    const deadlineModal = page.locator('.ant-modal').filter({ hasText: '批量调截止' })
    await expect(deadlineModal).toBeVisible()
    await deadlineModal.getByRole('button', { name: twoCharButton('应用') }).click()
    await expect(page.getByText(/已为 \d+ 张卡设置截止/)).toBeVisible()

    const savePromise = page.waitForResponse((res) =>
      res.url().includes('/task-generation/commit') && res.request().method() === 'POST' && res.status() < 300,
    { timeout: 90_000 })
    await page.getByRole('button', { name: '保存草稿' }).click()
    const saveJson = await (await savePromise).json()
    expect(saveJson.data.summary.taskStatus).toBe('DRAFT')
    expect(saveJson.data.summary.tasks).toBeGreaterThan(0)
    await expect(page.getByText('已进入任务管理', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '进入任务管理' })).toBeVisible()

    await setCardChecked(page, 0, false)
    await checkCard(page, 0)
    await page.getByRole('button', { name: /批量派发/ }).last().click()
    const dispatchModal = page.locator('.ant-modal').filter({ hasText: '批量派发' })
    await expect(dispatchModal).toBeVisible()
    await selectInAntdDropdown(page, dispatchModal, 0, member.phone)
    await selectInAntdDropdown(page, dispatchModal, 1, member.phone)
    const dispatchPromise = page.waitForResponse((res) =>
      res.url().includes('/task-generation/commit') && res.request().method() === 'POST' && res.status() < 300,
    { timeout: 90_000 })
    await dispatchModal.getByRole('button', { name: '确认派发' }).click()
    const dispatchJson = await (await dispatchPromise).json()
    expect(dispatchJson.data.summary.taskStatus).toBe('PENDING_APPROVAL')
    expect(dispatchJson.data.summary.tasks).toBeGreaterThan(0)

    const reqRes = await api.get(`/api/enterprise/standard-execution/requirements?sourceId=${encodeURIComponent(source.id)}&pageSize=100`)
    const reqJson = await readJson<{ total: number; data: Array<{ id: string; title: string; status: string }> }>(reqRes, 'list requirements')
    expect(reqJson.total).toBeGreaterThanOrEqual(saveJson.data.summary.requirements + dispatchJson.data.summary.requirements)

    const taskRes = await api.get(`/api/enterprise/standard-execution/tasks?keyword=${encodeURIComponent(runPrefix)}&pageSize=100`)
    const taskJson = await readJson<{ total: number; data: Array<{ id: string; title: string; status: string }> }>(taskRes, 'list tasks')
    expect(taskJson.total).toBeGreaterThanOrEqual(2)
    expect(taskJson.data.some((t) => t.status === 'DRAFT')).toBe(true)
    expect(taskJson.data.some((t) => t.status === 'PENDING_APPROVAL')).toBe(true)

    await api.dispose()
  })
})
