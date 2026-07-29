/**
 * SE Chat /send assistant 占位延迟创建。
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
    data: { enterpriseId: 'ENT_SE_PLACEHOLDER', enterpriseRole: 'EMPLOYEE' },
  })
  const conversation = await prisma.conversation.create({ data: { userId: user.id } })
  return { user, conversation, token: getTestToken(user.id, 'user') }
}

beforeEach(async () => {
  await cleanAll()
  await cleanStandardExecutionData()
  mockLLMStream.mockReset()
  mockIsLocalAi.mockReset()
  mockIsLocalAi.mockReturnValue(false)
  mockLocalReply.mockReset()
  mockLocalReply.mockReturnValue('LOCAL_MOCK_REPLY')
})

describe('POST /api/app/se-chat/send assistant placeholder', () => {
  it('LLM 首次 yield 前抛错时只保留 user error，不创建 assistant', async () => {
    mockLLMStream.mockImplementation(async function* () {
      throw new Error('upstream failed before first chunk')
    })
    const { conversation, token } = await enterpriseUser()

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conversation.id, message: '这条任务怎么执行' })

    const messages = await prisma.chatMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(res.status).toBe(200)
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].intent).toBe('error')
  })

  it('正常完成后 user/assistant 各一行，均标记为 se_chat', async () => {
    mockLLMStream.mockImplementation(async function* () { yield '已收到，我来协助处理。' })
    const { conversation, token } = await enterpriseUser()

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conversation.id, message: '这条任务怎么执行' })

    const messages = await prisma.chatMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(res.status).toBe(200)
    expect(messages).toHaveLength(2)
    expect(messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(messages.map(m => m.intent)).toEqual(['se_chat', 'se_chat'])
    expect(messages[1].content).toBe('已收到，我来协助处理。')
  })
})
