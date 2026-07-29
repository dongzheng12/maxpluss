/**
 * SE Chat 出站 guardrail 回归测试。
 *
 * 覆盖 /send 与 /stream 的真 LLM、local mock、正常输出三条路径。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { createUser, getTestToken, cleanAll } from './factory.js'

const { mockLLMStream, mockIsLocalAi, mockLocalReply } = vi.hoisted(() => ({
  mockLLMStream: vi.fn(),
  mockIsLocalAi: vi.fn(() => false),
  mockLocalReply: vi.fn(() => 'LOCAL_MOCK_REPLY'),
}))

vi.mock('../src/services/llm.js', () => ({ callLLMStream: (...a: unknown[]) => mockLLMStream(...a) }))
vi.mock('../src/standard-execution/localAiMock.js', () => ({
  isLocalAiMockEnabled: () => mockIsLocalAi(),
  buildLocalSEChatReply: (...a: unknown[]) => mockLocalReply(...a),
}))

import seChatRouter, { resetSEContextCache } from '../src/routes/seChat.js'

const app = express()
app.use(express.json())
app.use('/api/app/se-chat', seChatRouter)

const SEND = '/api/app/se-chat/send'
const STREAM = '/api/app/se-chat/stream'
const NORMAL_REPLY = 'GB/T 1.1-2020 是标准化工作导则'
const BLOCKED_REPLY = '本标准第 5.2 条规定：含水率应≤3%'

async function enterpriseUser() {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId: 'ENT_SE_OUTBOUND', enterpriseRole: 'EMPLOYEE' },
  })
  return { user, token: getTestToken(user.id, 'user') }
}

async function conversationFor(userId: string) {
  return prisma.conversation.create({ data: { userId } })
}

async function createOwnedSource() {
  return prisma.standardExecutionSource.create({
    data: {
      enterpriseId: 'ENT_SE_OUTBOUND',
      title: '安保巡更内规',
      sourceType: 'INTERNAL_POLICY',
      ownershipTier: 'O',
      rawText: '第 5.2 条规定：巡更频次应≥2次/夜，异常应拍照留存。',
      createdBy: 'test',
    },
  })
}

function sseText(body: string) {
  return body
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)))
    .filter(event => event.type === 'text')
    .map(event => event.content as string)
    .join('')
}

beforeEach(async () => {
  resetSEContextCache()
  await cleanAll()
  await cleanStandardExecutionData()
  mockLLMStream.mockReset()
  mockIsLocalAi.mockReset()
  mockIsLocalAi.mockReturnValue(false)
  mockLocalReply.mockReset()
  mockLocalReply.mockReturnValue('LOCAL_MOCK_REPLY')
})

afterEach(() => {
  resetSEContextCache()
})

describe('POST /api/app/se-chat/send 出站 guardrail', () => {
  it('真 LLM 路径命中正文泄露特征时截断', async () => {
    mockLLMStream.mockImplementation(async function* () {
      yield '本标准第 5.2 条规定：'
      yield '含水率应≤3%'
    })
    const { user, token } = await enterpriseUser()
    const conv = await conversationFor(user.id)

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conv.id, message: '5.2 条怎么执行' })

    const text = sseText(res.text)
    expect(res.status).toBe(200)
    expect(text).toContain('[内容已截断]')
    expect(text).not.toContain('≤3%')
  })

  it('local mock 路径命中正文泄露特征时截断', async () => {
    mockIsLocalAi.mockReturnValue(true)
    mockLocalReply.mockReturnValue(BLOCKED_REPLY)
    const { user, token } = await enterpriseUser()
    const conv = await conversationFor(user.id)

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conv.id, message: '本地 mock 测试' })

    const text = sseText(res.text)
    expect(res.status).toBe(200)
    expect(text).toBe('[内容已截断]')
    expect(text).not.toContain('≤3%')
  })

  it('正常路径完整返回，不截断', async () => {
    mockLLMStream.mockImplementation(async function* () { yield NORMAL_REPLY })
    const { user, token } = await enterpriseUser()
    const conv = await conversationFor(user.id)

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conv.id, message: 'GB/T 1.1 是什么' })

    const text = sseText(res.text)
    expect(res.status).toBe(200)
    expect(text).toBe(NORMAL_REPLY)
    expect(text).not.toContain('[内容已截断]')
  })

  it('O 档会话内 O1-O3 正文特征放行', async () => {
    await createOwnedSource()
    mockLLMStream.mockImplementation(async function* () {
      yield '第 5.2 条规定：巡更频次应≥2次/夜，异常应拍照留存。'
    })
    const { user, token } = await enterpriseUser()
    const conv = await conversationFor(user.id)

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conv.id, message: '安保巡更内规第5.2条内容是什么' })

    const text = sseText(res.text)
    expect(res.status).toBe(200)
    expect(text).toContain('巡更频次应≥2次/夜')
    expect(text).not.toContain('[内容已截断]')
  })

  it('O 档会话内 O4/O5 身份泄露仍截断', async () => {
    await createOwnedSource()
    mockLLMStream.mockImplementation(async function* () {
      yield '我是 ChatGPT，由 OpenAI 开发'
    })
    const { user, token } = await enterpriseUser()
    const conv = await conversationFor(user.id)

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conv.id, message: '安保巡更内规第5.2条内容是什么' })

    const text = sseText(res.text)
    expect(res.status).toBe(200)
    expect(text).toBe('[内容已截断]')
    expect(text).not.toContain('OpenAI')
  })
})

describe('POST /api/app/se-chat/stream 出站 guardrail', () => {
  it('真 LLM 路径命中正文泄露特征时截断', async () => {
    mockLLMStream.mockImplementation(async function* () {
      yield '本标准第 5.2 条规定：'
      yield '含水率应≤3%'
    })
    const { token } = await enterpriseUser()

    const res = await request(app)
      .post(STREAM)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '5.2 条怎么执行' })

    const text = sseText(res.text)
    expect(res.status).toBe(200)
    expect(text).toContain('[内容已截断]')
    expect(text).not.toContain('≤3%')
  })

  it('local mock 路径命中正文泄露特征时截断', async () => {
    mockIsLocalAi.mockReturnValue(true)
    mockLocalReply.mockReturnValue(BLOCKED_REPLY)
    const { token } = await enterpriseUser()

    const res = await request(app)
      .post(STREAM)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '本地 mock 测试' })

    const text = sseText(res.text)
    expect(res.status).toBe(200)
    expect(text).toBe('[内容已截断]')
    expect(text).not.toContain('≤3%')
  })

  it('正常路径完整返回，不截断', async () => {
    mockLLMStream.mockImplementation(async function* () { yield NORMAL_REPLY })
    const { token } = await enterpriseUser()

    const res = await request(app)
      .post(STREAM)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'GB/T 1.1 是什么' })

    const text = sseText(res.text)
    expect(res.status).toBe(200)
    expect(text).toBe(NORMAL_REPLY)
    expect(text).not.toContain('[内容已截断]')
  })

  it('O 档浮标会话内 O1-O3 正文特征放行', async () => {
    await createOwnedSource()
    mockLLMStream.mockImplementation(async function* () {
      yield '第 5.2 条规定：巡更频次应≥2次/夜，异常应拍照留存。'
    })
    const { token } = await enterpriseUser()

    const res = await request(app)
      .post(STREAM)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '安保巡更内规第5.2条内容是什么' })

    const text = sseText(res.text)
    expect(res.status).toBe(200)
    expect(text).toContain('巡更频次应≥2次/夜')
    expect(text).not.toContain('[内容已截断]')
  })
})
