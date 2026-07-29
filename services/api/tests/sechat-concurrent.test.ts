/**
 * SE Chat 同会话 /send 并发保护。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
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

import seChatRouter from '../src/routes/seChat.js'

const app = express()
app.use(express.json())
app.use('/api/app/se-chat', seChatRouter)

const SEND = '/api/app/se-chat/send'

async function enterpriseUser() {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId: 'ENT_SE_CONCURRENT', enterpriseRole: 'EMPLOYEE' },
  })
  const conversation = await prisma.conversation.create({ data: { userId: user.id } })
  return { user, conversation, token: getTestToken(user.id, 'user') }
}

beforeEach(async () => {
  await cleanAll()
  await cleanStandardExecutionData()
  mockLLMStream.mockReset()
  mockLLMStream.mockImplementation(async function* () { yield '已收到，我来协助处理。' })
  mockIsLocalAi.mockReset()
  mockIsLocalAi.mockReturnValue(false)
  mockLocalReply.mockReset()
  mockLocalReply.mockReturnValue('LOCAL_MOCK_REPLY')
})

describe('POST /api/app/se-chat/send 同会话并发保护', () => {
  it('存在 130 秒内 pending assistant 时返回 409', async () => {
    const { conversation, token } = await enterpriseUser()
    await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: '',
        intent: 'pending',
      },
    })

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conversation.id, message: '这条任务怎么执行' })

    expect(res.status).toBe(409)
    expect(res.body.error).toBe('该会话有未完成的请求，请稍后')
    expect(mockLLMStream).not.toHaveBeenCalled()
  })

  it('超过阈值的 pending assistant 会被标 error，并放行新请求', async () => {
    const { conversation, token } = await enterpriseUser()
    const stale = await prisma.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'assistant',
        content: '',
        intent: 'pending',
        createdAt: new Date(Date.now() - 5 * 60_000),
      },
    })

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conversation.id, message: '这条任务怎么执行' })

    const updated = await prisma.chatMessage.findUnique({ where: { id: stale.id } })
    expect(res.status).toBe(200)
    expect(res.text).toContain('"type":"done"')
    expect(updated?.intent).toBe('error')
    expect(updated?.content).toBe('请求超时，已自动取消')
  })
})
