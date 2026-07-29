import type { SmokeEnv } from '../types'
import { errorMessage } from './shape'

export interface SseEvent {
  type?: string
  [key: string]: unknown
}

export interface SseResponse {
  status: number
  ok: boolean
  text: string
  events: SseEvent[]
  comments: string[]
}

export function parseSseText(text: string): { events: SseEvent[]; comments: string[] } {
  const events: SseEvent[] = []
  const comments: string[] = []
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(':')) {
      comments.push(line.slice(1).trim())
      continue
    }
    if (!line.startsWith('data: ')) continue
    const payload = line.slice(6)
    try {
      const event = JSON.parse(payload)
      if (event && typeof event === 'object') events.push(event as SseEvent)
    } catch {
      events.push({ type: 'raw', content: payload })
    }
  }
  return { events, comments }
}

export function collectSseText(events: SseEvent[], type: string, field = 'content'): string {
  return events
    .filter((event) => event.type === type && typeof event[field] === 'string')
    .map((event) => String(event[field]))
    .join('')
}

export async function postJsonSse(
  env: SmokeEnv,
  token: string,
  path: string,
  body: unknown,
  timeoutMs = env.timeoutMs,
): Promise<SseResponse> {
  if (env.env === 'prod') {
    throw new Error(`prod 环境禁止 SSE POST ${path}`)
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  const url = path.startsWith('http') ? path : env.baseUrl + path
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    const text = await res.text()
    const parsed = parseSseText(text)
    return { status: res.status, ok: res.ok, text, events: parsed.events, comments: parsed.comments }
  } catch (e: unknown) {
    throw new Error(`SSE POST ${url} 失败: ${errorMessage(e)}`)
  } finally {
    clearTimeout(timer)
  }
}
