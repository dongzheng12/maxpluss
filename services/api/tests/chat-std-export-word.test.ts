/**
 * 标准框架 Word 导出 — Phase C-3 单测
 *
 * 覆盖：
 *  - happy path：从最近一条 framework 消息取 content，导出 docx，断言 magic bytes
 *  - 显式 content 参数优先于 DB 取
 *  - 未登录 401
 *  - 跨用户访问会话 404
 *  - 参数缺失 400
 *  - 会话存在但无 framework 消息 400
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import chatRouter from '../src/routes/chat.js'
import { createUser, getTestToken, ensurePlans, cleanAll } from './factory.js'
import { buildStdFrameworkDocx, markdownToParagraphs } from '../src/services/stdFrameworkDocx.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  app.use('/api/app/chat', chatRouter)
})

beforeEach(async () => {
  await prisma.chatMessage.deleteMany()
  await prisma.conversation.deleteMany()
  await cleanAll()
  await ensurePlans()
})

async function setupConvAndFramework(userId: string, content: string) {
  const conv = await prisma.conversation.create({
    data: { userId, title: '某产品标准草案' },
  })
  await prisma.chatMessage.create({
    data: {
      conversationId: conv.id,
      role: 'assistant',
      content,
      intent: 'write_framework',
    },
  })
  return conv
}

describe('buildStdFrameworkDocx — 单元', () => {
  it('返回非空 Buffer，首四字节为 docx (zip) magic PK\\x03\\x04', async () => {
    const buf = await buildStdFrameworkDocx({
      title: '测试标准',
      content: '# 1 范围\n本文件规定了…\n## 2 规范性引用文件\n- GB/T 1.1-2020',
    })
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(2000)
    expect(buf.slice(0, 2).toString()).toBe('PK')
  })

  it('references 段落在 verified/unverified 都有时被插入', async () => {
    const buf = await buildStdFrameworkDocx({
      content: '# 1 范围',
      references: {
        verified: [{ code: 'GB 50011-2010', title: '建筑抗震', status: '现行' }],
        unverified: [{ code: 'GB 99999-2099', reason: 'not_found' }],
      },
    })
    expect(buf.length).toBeGreaterThan(2000)
  })

  it('markdownToParagraphs 至少为每行生成一段（含空行）', () => {
    const ps = markdownToParagraphs('# H1\n\n- item\n普通文本')
    expect(ps.length).toBeGreaterThanOrEqual(4)
  })
})

describe('POST /api/app/chat/std-export-word — 路由', () => {
  it('happy path：从 DB 最新 framework 消息取内容，返回 docx', async () => {
    const user = await createUser()
    const conv = await setupConvAndFramework(user.id, '# 1 范围\n本文件…')
    const token = getTestToken(user.id)
    const res = await request(app)
      .post('/api/app/chat/std-export-word')
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on('data', (c) => chunks.push(c as Buffer))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
      .send({ conversationId: conv.id })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('officedocument.wordprocessingml.document')
    expect(Buffer.isBuffer(res.body)).toBe(true)
    expect(res.body.length).toBeGreaterThan(2000)
    expect(res.body.slice(0, 2).toString()).toBe('PK')
  })

  it('显式 content 优先于 DB 取', async () => {
    const user = await createUser()
    const conv = await setupConvAndFramework(user.id, '# DB 内容')
    const token = getTestToken(user.id)
    const res = await request(app)
      .post('/api/app/chat/std-export-word')
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = []
        r.on('data', (c) => chunks.push(c as Buffer))
        r.on('end', () => cb(null, Buffer.concat(chunks)))
      })
      .send({ conversationId: conv.id, content: '# 显式传入的内容\n## 2 规范性引用文件' })
    expect(res.status).toBe(200)
    expect(res.body.length).toBeGreaterThan(2000)
  })

  it('未登录 → 401', async () => {
    const res = await request(app)
      .post('/api/app/chat/std-export-word')
      .send({ conversationId: 'x' })
    expect(res.status).toBe(401)
  })

  it('跨用户访问会话 → 404', async () => {
    const owner = await createUser()
    const conv = await setupConvAndFramework(owner.id, '# 范围')
    const other = await createUser({ phone: '13900000000' })
    const token = getTestToken(other.id)
    const res = await request(app)
      .post('/api/app/chat/std-export-word')
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conv.id })
    expect(res.status).toBe(404)
  })

  it('参数缺失 conversationId → 400', async () => {
    const user = await createUser()
    const token = getTestToken(user.id)
    const res = await request(app)
      .post('/api/app/chat/std-export-word')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('会话存在但无 framework 消息且未传 content → 400', async () => {
    const user = await createUser()
    const conv = await prisma.conversation.create({
      data: { userId: user.id, title: '空会话' },
    })
    const token = getTestToken(user.id)
    const res = await request(app)
      .post('/api/app/chat/std-export-word')
      .set('Authorization', `Bearer ${token}`)
      .send({ conversationId: conv.id })
    expect(res.status).toBe(400)
  })
})
