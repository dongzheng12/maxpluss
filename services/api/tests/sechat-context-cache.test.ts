/**
 * SE Chat system prompt 企业上下文缓存。
 */
import { afterEach, describe, it, expect, beforeEach, vi } from 'vitest'
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

import seChatRouter, { invalidateSEContext, resetSEContextCache } from '../src/routes/seChat.js'

const app = express()
app.use(express.json())
app.use('/api/app/se-chat', seChatRouter)

const SEND = '/api/app/se-chat/send'

async function enterpriseUser(enterpriseId: string) {
  const user = await createUser({ role: 'user' })
  await prisma.appUser.update({
    where: { id: user.id },
    data: { enterpriseId, enterpriseRole: 'EMPLOYEE' },
  })
  const conversation = await prisma.conversation.create({ data: { userId: user.id } })
  return { user, conversation, token: getTestToken(user.id, 'user'), enterpriseId }
}

async function sendSEChat(token: string, conversationId: string) {
  return request(app)
    .post(SEND)
    .set('Authorization', `Bearer ${token}`)
    .send({ conversationId, message: '这条任务怎么执行' })
}

function spyContextQueries() {
  return {
    sources: vi.spyOn(prisma.standardExecutionSource, 'findMany'),
    requirements: vi.spyOn(prisma.standardExecutionRequirement, 'count'),
    tasks: vi.spyOn(prisma.standardExecutionTask, 'groupBy'),
  }
}

beforeEach(async () => {
  resetSEContextCache()
  await cleanAll()
  await cleanStandardExecutionData()
  mockLLMStream.mockReset()
  mockLLMStream.mockImplementation(async function* () { yield '已收到，我来协助处理。' })
  mockIsLocalAi.mockReset()
  mockIsLocalAi.mockReturnValue(false)
  mockLocalReply.mockReset()
  mockLocalReply.mockReturnValue('LOCAL_MOCK_REPLY')
})

afterEach(() => {
  resetSEContextCache()
  vi.restoreAllMocks()
})

describe('SE Chat context cache', () => {
  it('同一 enterpriseId 30s 内连续两次 /send 只查询一次上下文', async () => {
    const { token, conversation } = await enterpriseUser('ENT_SE_CACHE_A')
    const spies = spyContextQueries()

    const first = await sendSEChat(token, conversation.id)
    const second = await sendSEChat(token, conversation.id)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(spies.sources).toHaveBeenCalledTimes(1)
    expect(spies.requirements).toHaveBeenCalledTimes(1)
    expect(spies.tasks).toHaveBeenCalledTimes(1)
  })

  it('invalidateSEContext 后下一次 /send 会重新查询上下文', async () => {
    const { token, conversation, enterpriseId } = await enterpriseUser('ENT_SE_CACHE_B')
    const spies = spyContextQueries()

    const first = await sendSEChat(token, conversation.id)
    invalidateSEContext(enterpriseId)
    const second = await sendSEChat(token, conversation.id)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(spies.sources).toHaveBeenCalledTimes(2)
    expect(spies.requirements).toHaveBeenCalledTimes(2)
    expect(spies.tasks).toHaveBeenCalledTimes(2)
  })

  it('不同 enterpriseId 缓存互不污染', async () => {
    const a = await enterpriseUser('ENT_SE_CACHE_C1')
    const b = await enterpriseUser('ENT_SE_CACHE_C2')
    const spies = spyContextQueries()

    const first = await sendSEChat(a.token, a.conversation.id)
    const second = await sendSEChat(b.token, b.conversation.id)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(spies.sources).toHaveBeenCalledTimes(2)
    expect(spies.requirements).toHaveBeenCalledTimes(2)
    expect(spies.tasks).toHaveBeenCalledTimes(2)
  })
})
