import { describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { classifyAiPreviewError } from '../src/standard-execution/aiPreviewErrors.js'
import { AiCallFailedError } from '../src/standard-execution/aiClient.js'
import { registerTaskGenerationRoutes } from '../src/standard-execution/taskGenerationRoutes.js'

describe('SE AI preview error classification', () => {
  it.each([
    [{ status: 429, message: 'rate limited' }],
    [{ status: 503, message: 'service unavailable' }],
    [{ status: 504, message: 'gateway timeout' }],
    [new AiCallFailedError('LLM qwen timeout after 120000ms')],
    [{ code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' }],
  ])('maps overload-like errors to SE_AI_PREVIEW_OVERLOADED', (err) => {
    const payload = classifyAiPreviewError(err, '任务草稿预览失败')

    expect(payload.code).toBe('SE_AI_PREVIEW_OVERLOADED')
    expect(payload.error).toBe('AI 解析服务繁忙，请稍后重试')
    expect(payload.status).toBeGreaterThanOrEqual(429)
  })

  it('keeps domain errors as normal preview failures', () => {
    const payload = classifyAiPreviewError({ status: 404, message: '标准来源不存在或无权访问' }, '任务草稿预览失败')

    expect(payload).toEqual({
      status: 404,
      code: 'SE_AI_PREVIEW_FAILED',
      error: '标准来源不存在或无权访问',
    })
  })

  it('preview route maps gateway timeout to SE_AI_PREVIEW_OVERLOADED', async () => {
    const app = express()
    app.use(express.json())
    registerTaskGenerationRoutes(app, {
      basePath: '/task-generation',
      middleware: (_req, _res, next) => next(),
      resolveContext: () => {
        throw Object.assign(new Error('upstream gateway timeout'), { status: 504 })
      },
    })

    const res = await request(app)
      .post('/task-generation/preview')
      .send({ rawText: '1.1 应建立年度培训制度。', parseMode: 'RULE' })

    expect(res.status).toBe(504)
    expect(res.body).toMatchObject({
      code: 'SE_AI_PREVIEW_OVERLOADED',
      error: 'AI 解析服务繁忙，请稍后重试',
      detail: 'upstream gateway timeout',
    })
  })
})
