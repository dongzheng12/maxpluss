import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
}))

vi.mock('openai', () => {
  class APIError extends Error {
    status: number
    constructor(status = 500, message = 'api error') {
      super(message)
      this.status = status
    }
  }

  return {
    default: class MockOpenAI {
      static APIError = APIError
      chat = { completions: { create: createMock } }
    },
  }
})

describe('callLLM timeoutMs', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    createMock.mockReset()
    process.env.SVC_LLM_PRIMARY_KEY = 'test-primary'
    delete process.env.SVC_LLM_FALLBACK_KEY
  })

  afterEach(() => {
    vi.useRealTimers()
    delete process.env.SVC_LLM_PRIMARY_KEY
    delete process.env.SVC_LLM_FALLBACK_KEY
  })

  it('uses timeoutMs to abort non-stream calls instead of the 30s default', async () => {
    const signals: AbortSignal[] = []
    createMock.mockImplementation((_body: unknown, init: { signal: AbortSignal }) => {
      signals.push(init.signal)
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })

    const { callLLM, LLM_FALLBACK_REPLY } = await import('../src/services/llm.js')
    const pending = callLLM([{ role: 'user', content: 'x' }], { timeoutMs: 1_234 })

    await vi.advanceTimersByTimeAsync(1_233)
    expect(signals[0]?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(LLM_FALLBACK_REPLY)
    expect(signals[0]?.aborted).toBe(true)
  })
})
