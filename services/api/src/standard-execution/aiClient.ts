/**
 * standard-execution / AI 调用封装
 *
 * S1 实现：复用 llm.ts callLLM（DeepSeek → 千问双 provider 故障转移）。
 * STANDARD_AI_BASE_URL 不再需要；OCR_AI 模式走同一条路径，temperature=0 保证解析稳定性。
 *
 * 原 STANDARD_AI_BASE_URL / bxz-pyapi /standard-parse 方案留 S4.5 按需接入。
 */

import { callLLM } from '../services/llm'
import { buildLocalStandardAiMockResponse, isLocalAiMockEnabled } from './localAiMock.js'

const STANDARD_AI_TIMEOUT_MS = 120_000

export class AiNotConfiguredError extends Error {
  code = 'AI_NOT_CONFIGURED'
  constructor() {
    super('AI 服务未就绪')
  }
}

export class AiCallFailedError extends Error {
  code = 'AI_CALL_FAILED'
  constructor(public reason: string) {
    super(`AI 调用失败：${reason}`)
  }
}

/**
 * 调用标准解析 AI。
 *   - 走 callLLM（DeepSeek primary → 千问 fallback）
 *   - temperature=0 保证条款解析结果稳定
 *   - 任何失败 → 抛 AiCallFailedError，由调用方（parseAi）捕获后降级到 RULE 模式
 *
 * 接口对外只暴露 Promise<string>。返回的字符串由 parseAi 负责 JSON.parse + zod 校验。
 */
export async function callStandardAI(prompt: string): Promise<string> {
  if (isLocalAiMockEnabled()) {
    return buildLocalStandardAiMockResponse(prompt)
  }
  try {
    // #4 二轮: 显式传 maxTokens=8192，防 llm.ts 默认 2048 截断长 JSON
    // （GB/T1032 单段提取输出超 2048 tokens → Unterminated string → AI_INVALID_JSON 根因）
    return await callLLM(
      [{ role: 'user', content: prompt }],
      { temperature: 0, maxTokens: 8192, timeoutMs: STANDARD_AI_TIMEOUT_MS },
    )
  } catch (err) {
    throw new AiCallFailedError(err instanceof Error ? err.message : 'unknown')
  }
}
