/**
 * SE Chat SSE heartbeat helper.
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupSSE } from '../src/routes/seChat.js'

class MockSSEResponse extends EventEmitter {
  headers = new Map<string, string>()
  writes: string[] = []
  setHeader = vi.fn((key: string, value: string) => { this.headers.set(key, value) })
  flushHeaders = vi.fn()
  flush = vi.fn()
  write = vi.fn((chunk: string) => { this.writes.push(chunk) })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('setupSSE heartbeat', () => {
  it('sets no-buffer headers and nginx timeout extension', () => {
    vi.useFakeTimers()
    const res = new MockSSEResponse()

    setupSSE(res)

    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(res.headers.get('Cache-Control')).toBe('no-cache')
    expect(res.headers.get('Connection')).toBe('keep-alive')
    expect(res.headers.get('X-Accel-Buffering')).toBe('no')
    expect(res.headers.get('X-Accel-Timeout')).toBe('300')
    expect(res.flushHeaders).toHaveBeenCalledOnce()
  })

  it('writes : ping every 25s and clears interval on close', () => {
    vi.useFakeTimers()
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const res = new MockSSEResponse()

    const sendEvent = setupSSE(res)
    vi.advanceTimersByTime(25_000)
    expect(res.write).toHaveBeenCalledWith(': ping\n\n')

    sendEvent({ type: 'done' })
    expect(res.write).toHaveBeenCalledWith('data: {"type":"done"}\n\n')
    expect(res.flush).toHaveBeenCalledOnce()

    const writesAfterFirstPing = res.writes.length
    res.emit('close')
    expect(clearIntervalSpy).toHaveBeenCalled()

    vi.advanceTimersByTime(25_000)
    expect(res.writes).toHaveLength(writesAfterFirstPing)
  })

  it('clears interval when ping write throws', () => {
    vi.useFakeTimers()
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const res = new MockSSEResponse()
    res.write.mockImplementationOnce(() => { throw new Error('closed') })

    setupSSE(res)
    vi.advanceTimersByTime(25_000)

    expect(clearIntervalSpy).toHaveBeenCalled()
  })
})
