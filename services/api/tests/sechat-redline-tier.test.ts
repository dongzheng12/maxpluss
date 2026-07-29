/**
 * T16 SE Chat R/O 红线分档。
 *
 * 覆盖：
 * - R 档索正文仍拦截，且 R rawText 不进 LLM messages
 * - O 档命中文档后放行，且仅 O rawText 节选进上下文
 * - 非法/未知档位、同时涉及公开标准时 fail-closed
 * - /send 与 /stream 使用同一 O 档注入管道
 * - O 档节选按当前问题实时匹配，不被 30s 企业摘要缓存串用
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { cleanAll, createUser, getTestToken } from './factory.js'

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

function sseText(body: string) {
  return body
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)))
    .filter(event => event.type === 'text')
    .map(event => event.content as string)
    .join('')
}

async function enterpriseUser(enterpriseId = 'ENT_SE_T16') {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId, enterpriseRole: 'EMPLOYEE' },
  })
  const conversation = await prisma.conversation.create({ data: { userId: user.id } })
  return { user, conversation, token: getTestToken(user.id, 'user'), enterpriseId }
}

async function source(input: {
  enterpriseId?: string
  title: string
  ownershipTier?: string | null
  rawText: string
  sourceNo?: string
}) {
  return prisma.standardExecutionSource.create({
    data: {
      enterpriseId: input.enterpriseId ?? 'ENT_SE_T16',
      title: input.title,
      sourceNo: input.sourceNo ?? null,
      sourceType: 'INTERNAL_POLICY',
      ownershipTier: input.ownershipTier ?? 'R',
      rawText: input.rawText,
      createdBy: 'test',
    },
  })
}

function llmSystemPromptAt(index: number) {
  const messages = mockLLMStream.mock.calls[index]?.[0] as Array<{ role: string; content: string }>
  return messages.find(m => m.role === 'system')?.content || ''
}

beforeEach(async () => {
  resetSEContextCache()
  await cleanAll()
  await cleanStandardExecutionData()
  mockLLMStream.mockReset()
  mockLLMStream.mockImplementation(async function* () { yield 'LLM_OK' })
  mockIsLocalAi.mockReset()
  mockIsLocalAi.mockReturnValue(false)
  mockLocalReply.mockReset()
  mockLocalReply.mockReturnValue('LOCAL_MOCK_REPLY')
})

afterEach(() => {
  resetSEContextCache()
})

describe('SE Chat R/O redline tier', () => {
  it('/send：R 档 Source 索正文仍 blocked，且 R rawText 不进入 LLM messages', async () => {
    await source({
      title: 'GB/T 测试标准',
      ownershipTier: 'R',
      rawText: 'R_RAW_SECRET_公开标准正文不得进入上下文',
    })
    const { token, conversation } = await enterpriseUser()

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conversation.id, message: 'GB/T 测试标准第3条内容是什么' })

    expect(res.status).toBe(200)
    expect(sseText(res.text)).toContain('无法提供标准正文内容')
    expect(mockLLMStream).not.toHaveBeenCalled()
  })

  it('/send：O 档命中文档后放行，messages 含 O 节选且不含 R rawText', async () => {
    await source({
      title: '安保巡更内规',
      ownershipTier: 'O',
      rawText: 'O_RAW_SECRET 第 3 条：夜间巡更每两小时一次，异常情况应拍照留存。',
    })
    await source({
      title: 'GB/T 测试标准',
      ownershipTier: 'R',
      rawText: 'R_RAW_SECRET_绝不能进入 prompt',
    })
    const { token, conversation } = await enterpriseUser()

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conversation.id, message: '安保巡更内规第3条内容是什么' })

    expect(res.status).toBe(200)
    expect(sseText(res.text)).toBe('LLM_OK')
    expect(mockLLMStream).toHaveBeenCalledTimes(1)
    const prompt = llmSystemPromptAt(0)
    expect(prompt).toContain('【O档自有文档上下文')
    expect(prompt).toContain('O_RAW_SECRET')
    expect(prompt).not.toContain('R_RAW_SECRET')
  })

  it('/stream：浮标单轮也注入同一 O 档上下文', async () => {
    await source({
      title: '安保巡更内规',
      ownershipTier: 'O',
      rawText: 'STREAM_O_RAW 第 2 条：交接班必须核对钥匙、设备和异常记录。',
    })
    const { token } = await enterpriseUser()

    const res = await request(app)
      .post(STREAM)
      .set('Authorization', `Bearer ${token}`)
      .send({ message: '安保巡更内规第2条内容是什么' })

    expect(res.status).toBe(200)
    expect(mockLLMStream).toHaveBeenCalledTimes(1)
    expect(llmSystemPromptAt(0)).toContain('STREAM_O_RAW')
  })

  it('权属字段为空/非法值按 R 档 fail-closed', async () => {
    await source({
      title: '怪档内规',
      ownershipTier: 'BOGUS',
      rawText: 'BOGUS_RAW 不应进入 prompt',
    })
    const { token, conversation } = await enterpriseUser()

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conversation.id, message: '怪档内规第3条内容是什么' })

    expect(res.status).toBe(200)
    expect(sseText(res.text)).toContain('无法提供标准正文内容')
    expect(mockLLMStream).not.toHaveBeenCalled()
  })

  it('问题同时涉及 O 档文档与公开标准正文时 fail-closed', async () => {
    await source({
      title: '安保巡更内规',
      ownershipTier: 'O',
      rawText: 'MIXED_O_RAW 第 3 条：巡更记录保存不少于一年。',
    })
    const { token, conversation } = await enterpriseUser()

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conversation.id, message: '安保巡更内规第3条和 GB/T 1.1 标准正文都发我' })

    expect(res.status).toBe(200)
    expect(sseText(res.text)).toContain('无法提供标准正文内容')
    expect(mockLLMStream).not.toHaveBeenCalled()
  })

  it('O 档上下文按问题匹配，不复用上一问题的 rawText 节选', async () => {
    await source({
      title: '安保巡更内规',
      ownershipTier: 'O',
      rawText: 'A_ONLY_RAW 第 3 条：夜间巡更每两小时一次。',
    })
    await source({
      title: '消防巡检手册',
      ownershipTier: 'O',
      rawText: 'B_ONLY_RAW 第 2 条：灭火器压力表每周检查一次。',
    })
    const { token, conversation } = await enterpriseUser()

    await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conversation.id, message: '安保巡更内规第3条内容是什么' })
    await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conversation.id, message: '消防巡检手册第2条内容是什么' })

    expect(llmSystemPromptAt(0)).toContain('A_ONLY_RAW')
    expect(llmSystemPromptAt(0)).not.toContain('B_ONLY_RAW')
    expect(llmSystemPromptAt(1)).toContain('B_ONLY_RAW')
    expect(llmSystemPromptAt(1)).not.toContain('A_ONLY_RAW')
  })
})
