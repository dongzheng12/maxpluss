/**
 * /health 端到端测试
 *
 * deploy-bxz-api.sh 会：
 *   1. canary 阶段校验 commit 字段 == 本次发版 commit（核心防误打旧容器）
 *   2. 正式切换后再次校验 commit
 * 所以 /health 的 schema 是契约，改动这里要同步改 deploy 脚本。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { healthPayload } from '../src/version.js'

// 轻量 app：只挂 /health，不引导主 routes（/health 本身不依赖 DB/state）
const app = express()
beforeAll(() => {
  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store')
    res.json(healthPayload())
  })
})

describe('GET /health', () => {
  it('200 + ok:true + 必需字段完整（service/commit/builtAt/startedAt/pid）', async () => {
    const res = await request(app).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.service).toBe('bxz-api')
    expect(typeof res.body.commit).toBe('string')
    expect(typeof res.body.builtAt).toBe('string')
    expect(typeof res.body.startedAt).toBe('string')
    expect(typeof res.body.pid).toBe('number')
  })

  it('Cache-Control: no-store（防轮询缓存误判）', async () => {
    const res = await request(app).get('/health')
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('startedAt 是合法 ISO 日期', async () => {
    const res = await request(app).get('/health')
    expect(() => new Date(res.body.startedAt).toISOString()).not.toThrow()
  })

  it('BUILD_COMMIT env 被读取到 commit 字段（deploy 脚本用来核验版本）', async () => {
    // 本地测试环境 env 未设，fallback 到 'dev'；生产 docker build --build-arg 会注入真实 commit
    const res = await request(app).get('/health')
    if (process.env.BUILD_COMMIT) {
      expect(res.body.commit).toBe(process.env.BUILD_COMMIT)
    } else {
      expect(res.body.commit).toBe('dev')
    }
  })

  it('同一进程多次调用 startedAt / pid 不变（确认是稳定身份字段）', async () => {
    const r1 = await request(app).get('/health')
    const r2 = await request(app).get('/health')
    expect(r1.body.startedAt).toBe(r2.body.startedAt)
    expect(r1.body.pid).toBe(r2.body.pid)
  })
})
