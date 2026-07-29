import { createContext } from 'react'

/** 当前页面可见数据的上下文，供 AI 浮标拼入消息（页面级数据上下文注入） */
export interface SEPageData {
  pageKey: string // 'sources' | 'tasks' | 'my-tasks' | 'reviews'
  summary: string // 当前页数据的文字摘要，直接拼进 AI 消息
}

/**
 * P1-8: 详情页「问小智」触发器。
 * 详情页点击「问小智」时调 triggerAsk(对象上下文, 预设问题)，
 * SEAIFloatingBubble 监听 ask.nonce 变化 → 打开抽屉 + 携带对象上下文发送问题。
 */
export interface SEAskTrigger {
  contextText: string // 当前业务对象的文字/JSON 上下文
  question: string // 预设问题
  nonce: number // 每次触发递增，驱动浮标响应
}

export const SEPageContext = createContext<{
  data: SEPageData | null
  setData: (d: SEPageData | null) => void
  ask: SEAskTrigger | null
  triggerAsk: (contextText: string, question: string) => void
}>({ data: null, setData: () => {}, ask: null, triggerAsk: () => {} })
