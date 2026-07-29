/**
 * SE Chat 会话管理 CRUD（/api/app/se-chat/conversations*）。
 *
 * 覆盖：创建 / 列表（仅本人、倒序）/ 历史 / 重命名 / 删除（含带消息会话的 FK 回归）。
 * 回归背景：DELETE 原先直接删 Conversation，带 ChatMessage 的会话因无级联触发 P2003 → 500。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { createUser, getTestToken, cleanAll } from './factory.js'

import seChatRouter from '../src/routes/seChat.js'

const app = express()
app.use(express.json())
app.use('/api/app/se-chat', seChatRouter)

const BASE = '/api/app/se-chat/conversations'

async function userWithToken() {
  const user = await createUser({ role: 'user' })
  return { user, token: getTestToken(user.id, 'user') }
}

beforeEach(async () => {
  await cleanAll()
})

describe('POST /api/app/se-chat/conversations', () => {
  it('创建会话并归属当前用户', async () => {
    const { user, token } = await userWithToken()
    const res = await request(app).post(BASE).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.id).toBeTruthy()
    const row = await prisma.conversation.findUnique({ where: { id: res.body.id } })
    expect(row?.userId).toBe(user.id)
  })

  it('无 token 返回 401', async () => {
    const res = await request(app).post(BASE)
    expect(res.status).toBe(401)
  })
})

describe('GET /api/app/se-chat/conversations', () => {
  it('只返回当前用户的会话，按 updatedAt 倒序', async () => {
    const { user, token } = await userWithToken()
    const { user: other } = await userWithToken()
    const older = await prisma.conversation.create({
      data: { userId: user.id, title: '旧会话', updatedAt: new Date(Date.now() - 60_000) },
    })
    const newer = await prisma.conversation.create({ data: { userId: user.id, title: '新会话' } })
    await prisma.conversation.create({ data: { userId: other.id, title: '别人的' } })

    const res = await request(app).get(BASE).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(2)
    expect(res.body[0].id).toBe(newer.id)
    expect(res.body[1].id).toBe(older.id)
  })
})

describe('GET /api/app/se-chat/history/:conversationId', () => {
  it('返回会话消息，过滤空内容与 pending 占位', async () => {
    const { user, token } = await userWithToken()
    const conv = await prisma.conversation.create({ data: { userId: user.id } })
    // intent 必须非 NULL：路由的 NOT intent='pending' 过滤在 SQL 里会把 NULL 行一并滤掉，
    // 真实链路写入的消息都带 intent，这里对齐真实数据形态
    await prisma.chatMessage.create({
      data: { conversationId: conv.id, role: 'user', content: '你好', intent: 'chat' },
    })
    await prisma.chatMessage.create({
      data: { conversationId: conv.id, role: 'assistant', content: '', intent: 'pending' },
    })
    const res = await request(app)
      .get(`/api/app/se-chat/history/${conv.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].content).toBe('你好')
  })

  it('他人会话返回 404', async () => {
    const { token } = await userWithToken()
    const { user: other } = await userWithToken()
    const conv = await prisma.conversation.create({ data: { userId: other.id } })
    const res = await request(app)
      .get(`/api/app/se-chat/history/${conv.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })
})

describe('PATCH /api/app/se-chat/conversations/:conversationId', () => {
  it('重命名成功并落库', async () => {
    const { user, token } = await userWithToken()
    const conv = await prisma.conversation.create({ data: { userId: user.id } })
    const res = await request(app)
      .patch(`${BASE}/${conv.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '巡检问题讨论' })
    expect(res.status).toBe(200)
    expect(res.body.title).toBe('巡检问题讨论')
    const row = await prisma.conversation.findUnique({ where: { id: conv.id } })
    expect(row?.title).toBe('巡检问题讨论')
  })

  it('title 为空或超 100 字返回 400', async () => {
    const { user, token } = await userWithToken()
    const conv = await prisma.conversation.create({ data: { userId: user.id } })
    const empty = await request(app)
      .patch(`${BASE}/${conv.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '   ' })
    expect(empty.status).toBe(400)
    const tooLong = await request(app)
      .patch(`${BASE}/${conv.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'x'.repeat(101) })
    expect(tooLong.status).toBe(400)
  })

  it('他人会话返回 404', async () => {
    const { token } = await userWithToken()
    const { user: other } = await userWithToken()
    const conv = await prisma.conversation.create({ data: { userId: other.id } })
    const res = await request(app)
      .patch(`${BASE}/${conv.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: '越权改名' })
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/app/se-chat/conversations/:conversationId', () => {
  it('删除带消息的会话（FK 回归：消息须随会话清掉）', async () => {
    const { user, token } = await userWithToken()
    const conv = await prisma.conversation.create({ data: { userId: user.id } })
    await prisma.chatMessage.create({
      data: { conversationId: conv.id, role: 'user', content: '这条消息曾导致 P2003' },
    })
    await prisma.chatMessage.create({
      data: { conversationId: conv.id, role: 'assistant', content: '回复' },
    })
    const res = await request(app)
      .delete(`${BASE}/${conv.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(await prisma.conversation.findUnique({ where: { id: conv.id } })).toBeNull()
    expect(await prisma.chatMessage.count({ where: { conversationId: conv.id } })).toBe(0)
  })

  it('删除空会话成功', async () => {
    const { user, token } = await userWithToken()
    const conv = await prisma.conversation.create({ data: { userId: user.id } })
    const res = await request(app)
      .delete(`${BASE}/${conv.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('不存在的会话返回 404', async () => {
    const { token } = await userWithToken()
    const res = await request(app)
      .delete(`${BASE}/00000000-0000-0000-0000-000000000000`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
  })

  it('他人会话返回 404 且不删除', async () => {
    const { token } = await userWithToken()
    const { user: other } = await userWithToken()
    const conv = await prisma.conversation.create({ data: { userId: other.id } })
    const res = await request(app)
      .delete(`${BASE}/${conv.id}`)
      .set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
    expect(await prisma.conversation.findUnique({ where: { id: conv.id } })).not.toBeNull()
  })

  it('无 token 返回 401', async () => {
    const res = await request(app).delete(`${BASE}/whatever`)
    expect(res.status).toBe(401)
  })
})
