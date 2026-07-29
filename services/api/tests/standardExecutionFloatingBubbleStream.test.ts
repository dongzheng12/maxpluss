/**
 * P1-8 浮标单轮 /api/app/se-chat/stream（SSE，无状态，不持久化对话）测试
 *
 * mock 依赖：callLLMStream / isLocalAiMockEnabled / buildLocalSEChatReply / checkGuardrail（不真调 DeepSeek）。
 * 覆盖：200 SSE 流式 / 401 / 400(缺失·超长) / 403 非企业 / guard.blocked 拦截 / local mock。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { createUser, getTestToken } from './factory.js'

const { mockLLMStream, mockIsLocalAi, mockLocalReply, mockGuard } = vi.hoisted(() => ({
  mockLLMStream: vi.fn(),
  mockIsLocalAi: vi.fn(() => false),
  mockLocalReply: vi.fn(() => 'LOCAL_MOCK_REPLY'),
  mockGuard: vi.fn(() => ({ blocked: false })),
}))
vi.mock('../src/services/llm.js', () => ({ callLLMStream: (...a: unknown[]) => mockLLMStream(...a) }))
vi.mock('../src/standard-execution/localAiMock.js', () => ({
  isLocalAiMockEnabled: () => mockIsLocalAi(),
  buildLocalSEChatReply: (...a: unknown[]) => mockLocalReply(...a),
}))
vi.mock('../src/services/chatGuardrail.js', () => ({
  checkGuardrail: (...a: unknown[]) => mockGuard(...a),
  SYSTEM_GUARDRAIL: 'GUARDRAIL_PLACEHOLDER',
  createOutboundGuard: () => ({ check: () => null, reset: () => {} }),
}))

import seChatRouter from '../src/routes/seChat.js'

const app = express()
app.use(express.json())
app.use('/api/app/se-chat', seChatRouter)

const STREAM = '/api/app/se-chat/stream'

async function enterpriseUser() {
  const u = await createUser({ role: 'user' })
  await prisma.appUser.update({ where: { id: u.id }, data: { enterpriseId: 'DEFAULT', enterpriseRole: 'EMPLOYEE' } })
  return { u, token: getTestToken(u.id, 'user') }
}

beforeEach(() => {
  mockLLMStream.mockReset()
  mockIsLocalAi.mockReset(); mockIsLocalAi.mockReturnValue(false)
  mockLocalReply.mockReset(); mockLocalReply.mockReturnValue('LOCAL_MOCK_REPLY')
  mockGuard.mockReset(); mockGuard.mockReturnValue({ blocked: false })
})

describe('POST /api/app/se-chat/stream（浮标单轮）', () => {
  it('200 SSE：真 LLM 路径流式返回 text 事件 + done', async () => {
    mockLLMStream.mockImplementation(async function* () { yield 'hello '; yield 'world' })
    const { token } = await enterpriseUser()
    const res = await request(app).post(STREAM).set('Authorization', `Bearer ${token}`).send({ message: '这条检查点怎么执行' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.text).toContain('"type":"text"')
    expect(res.text).toContain('hello')
    expect(res.text).toContain('world')
    expect(res.text).toContain('"type":"done"')
  })

  it('401 未登录', async () => {
    const res = await request(app).post(STREAM).send({ message: 'hi' })
    expect(res.status).toBe(401)
  })

  it('400 message 缺失', async () => {
    const { token } = await enterpriseUser()
    const res = await request(app).post(STREAM).set('Authorization', `Bearer ${token}`).send({})
    expect(res.status).toBe(400)
  })

  it('400 message 超 3000', async () => {
    const { token } = await enterpriseUser()
    const res = await request(app).post(STREAM).set('Authorization', `Bearer ${token}`).send({ message: 'x'.repeat(3001) })
    expect(res.status).toBe(400)
  })

  it('403 非企业用户（无 enterpriseId）', async () => {
    const u = await createUser({ role: 'user' })
    const res = await request(app).post(STREAM).set('Authorization', `Bearer ${getTestToken(u.id, 'user')}`).send({ message: 'hi' })
    expect(res.status).toBe(403)
  })

  it('200 guard.blocked → 返回拦截 reply，不走 LLM', async () => {
    mockGuard.mockReturnValue({ blocked: true, reply: '该问题超出范围' })
    const { token } = await enterpriseUser()
    const res = await request(app).post(STREAM).set('Authorization', `Bearer ${token}`).send({ message: '违规问题' })
    expect(res.status).toBe(200)
    expect(res.text).toContain('"intent":"blocked"')
    expect(res.text).toContain('该问题超出范围')
    expect(mockLLMStream).not.toHaveBeenCalled()
  })

  it('200 local mock 模式走 buildLocalSEChatReply，不走 LLM', async () => {
    mockIsLocalAi.mockReturnValue(true)
    const { token } = await enterpriseUser()
    const res = await request(app).post(STREAM).set('Authorization', `Bearer ${token}`).send({ message: 'hi' })
    expect(res.status).toBe(200)
    expect(res.text).toContain('LOCAL_MOCK_REPLY')
    expect(mockLLMStream).not.toHaveBeenCalled()
  })
})
