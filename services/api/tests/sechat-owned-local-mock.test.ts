/**
 * T16 localAiMock O 档引用路径。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { cleanStandardExecutionData } from './seClean.js'
import { cleanAll, createUser, getTestToken } from './factory.js'
import seChatRouter, { resetSEContextCache } from '../src/routes/seChat.js'

const app = express()
app.use(express.json())
app.use('/api/app/se-chat', seChatRouter)

const SEND = '/api/app/se-chat/send'

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
  process.env.SE_AI_MOCK = '1'
})

afterEach(() => {
  resetSEContextCache()
  delete process.env.SE_AI_MOCK
})

describe('SE Chat localAiMock owned source context', () => {
  it('/send 在 O 档命中时引用节选原文，且不被 O1-O3 出站截断', async () => {
    const user = await createUser({ role: 'user' })
    await prisma.appUser.update({
      where: { id: user.id },
      data: { enterpriseId: 'ENT_SE_LOCAL_MOCK', enterpriseRole: 'EMPLOYEE' },
    })
    await prisma.standardExecutionSource.create({
      data: {
        enterpriseId: 'ENT_SE_LOCAL_MOCK',
        title: '安保巡更内规',
        sourceType: 'INTERNAL_POLICY',
        ownershipTier: 'O',
        rawText: 'LOCAL_MOCK_O_RAW 第 3 条：夜间巡更每两小时一次，异常情况应拍照留存。',
        createdBy: user.id,
      },
    })
    const conversation = await prisma.conversation.create({ data: { userId: user.id } })

    const res = await request(app)
      .post(SEND)
      .set('Authorization', `Bearer ${getTestToken(user.id, 'user')}`)
      .send({ conversationId: conversation.id, message: '安保巡更内规第3条内容是什么' })

    const text = sseText(res.text)
    expect(res.status).toBe(200)
    expect(text).toContain('LOCAL_MOCK_O_RAW')
    expect(text).toContain('第 3 条')
    expect(text).not.toContain('[内容已截断]')
  })
})
