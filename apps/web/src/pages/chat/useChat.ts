import { useState, useCallback, useRef } from 'react'
import { message as antMsg } from 'antd'
import { nodeApi } from '../../api/client'
import { deleteConversationApi as _deleteConversationApi, renameConversation as _renameConversationApi } from '../../api/app'

// ─── 类型定义 ──────────────────────────────────────────────

export interface SearchResultItem {
  code: string
  title: string
  status: string
  implDate: string
  pubDate?: string
  committee?: string
  replacedBy?: string | null
  industry?: string
  detailUrl: string
}

export interface TaskItem {
  taskNo: string
  documentName: string
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED'
  createdAt: string
  reportUrl: string | null
}

export interface ActionItem {
  action: 'redirect' | 'external'
  url: string
  label: string
}

export interface SuggestionItem {
  text: string
  label: string
}

export interface BlockedData {
  content: string
  officialLinks: Array<{ label: string; url: string }>
  suggestions: string[]
}

export interface WebSearchSourceItem {
  title: string
  url: string
  site_name?: string
  index?: number
}

export interface ConfidenceInfo {
  level: 'high' | 'medium' | 'low'
  emoji: '🟢' | '🟡' | '🔴'
  label: string
}

export interface Message {
  id?: string
  role: 'user' | 'assistant'
  content: string
  intent?: string
  isStreaming?: boolean
  statusMessage?: string
  searchResults?: { total: number; items: SearchResultItem[]; moreUrl: string }
  webSearchResults?: { items: WebSearchSourceItem[]; note?: string }
  confidence?: ConfidenceInfo
  taskList?: TaskItem[]
  blockedData?: BlockedData
  actions?: ActionItem[]
  suggestions?: SuggestionItem[]
  showOutlineActions?: boolean
  outlineTier?: string
  showFrameworkDownload?: boolean
  verifiedReferences?: VerifiedReferencesInfo
}

export interface VerifiedRefItem {
  code: string
  title: string
  status: string
  implDate?: string
}
export interface UnverifiedRefItem {
  code: string
  reason: 'not_found' | 'timeout' | 'error'
}
export interface VerifiedReferencesInfo {
  verified: VerifiedRefItem[]
  unverified: UnverifiedRefItem[]
  total: number
}

export interface Conversation {
  id: string
  title: string
  updatedAt: string
}

const BASE = import.meta.env.DEV ? '/node-api' : ''

export interface UseChatOptions {
  /** 覆盖默认的 /api/app/chat，用于 SE 助手指向 /api/app/se-chat */
  apiBase?: string
}

export function useChat(opts: UseChatOptions = {}) {
  const chatBase = opts.apiBase ?? '/api/app/chat'
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [currentConvId, setCurrentConvId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [isLoadingHistory, setIsLoadingHistory] = useState(false)
  const [remainingQuota, setRemainingQuota] = useState<number | null>(null)
  const [quotaTier, setQuotaTier] = useState<string>('free')
  const abortRef = useRef<AbortController | null>(null)

  const loadConversations = useCallback(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await nodeApi.get(`${chatBase}/conversations`) as any
      setConversations(Array.isArray(data) ? data : [])
    } catch (err) {
      console.error('加载会话列表失败', err)
      antMsg.error('加载会话列表失败')
    }
  }, [])

  const switchConversation = useCallback(async (convId: string) => {
    setCurrentConvId(convId)
    setMessages([])
    setIsLoadingHistory(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await nodeApi.get(`${chatBase}/history/${convId}`) as any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msgs: Message[] = (Array.isArray(data) ? data : []).map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        intent: m.intent,
      }))
      setMessages(msgs)
    } catch (err) {
      console.error('加载对话历史失败', err)
      antMsg.error('加载对话历史失败')
    } finally {
      setIsLoadingHistory(false)
    }
  }, [])

  // 延迟创建：点新建只清空界面，等真正发消息时才调 API
  const createNewConversation = useCallback((): string | null => {
    setCurrentConvId(null)
    setMessages([])
    return null
  }, [])

  // 内部方法：真正创建会话（发消息时调用）
  const doCreateConversation = useCallback(async (): Promise<string | null> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await nodeApi.post(`${chatBase}/conversations`) as any
      const convId = data.id
      setCurrentConvId(convId)
      loadConversations()
      return convId
    } catch (err) {
      console.error('创建会话失败', err)
      antMsg.error('创建会话失败')
      return null
    }
  }, [loadConversations])

  // ─── 更新最后一条 assistant 消息的辅助函数 ────────────────

  const updateLastAssistant = useCallback((updater: (msg: Message) => Partial<Message>) => {
    setMessages(prev => {
      const updated = [...prev]
      const last = updated[updated.length - 1]
      if (last?.role === 'assistant') {
        updated[updated.length - 1] = { ...last, ...updater(last) }
      }
      return updated
    })
  }, [])

  // ─── SSE 流式处理核心 ────────────────────────────────────

  const processSSE = useCallback(async (
    url: string,
    body: Record<string, unknown>,
    _retryCount = 0,
  ) => {
    const MAX_RETRIES = 2
    const token = localStorage.getItem('bxz_token')
    // 先取消之前的请求
    if (abortRef.current) {
      abortRef.current.abort()
    }
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const response = await fetch(`${BASE}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (response.status === 401) {
        localStorage.removeItem('bxz_token')
        localStorage.removeItem('bxz_user')
        localStorage.removeItem('bxz_user_id')
        window.dispatchEvent(new CustomEvent('bxz-auth-expired'))
        updateLastAssistant(() => ({
          content: '登录状态已失效，请重新登录后继续。',
          isStreaming: false,
          actions: [{ action: 'redirect' as const, url: '/login?redirect=/chat', label: '重新登录' }],
        }))
        setIsStreaming(false)
        return
      }

      if (response.status === 429) {
        updateLastAssistant(() => ({
          content: '今日免费对话额度已用完，升级会员享无限对话。',
          intent: 'quota_exceeded',
          isStreaming: false,
        }))
        setIsStreaming(false)
        setRemainingQuota(0)
        return
      }

      if (response.status === 403) {
        const err = await response.json()
        updateLastAssistant(() => ({
          content: err.error || '权限不足',
          isStreaming: false,
          actions: [{ action: 'redirect' as const, url: '/membership', label: '升级会员' }],
        }))
        setIsStreaming(false)
        return
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let assistantContent = ''
      const actions: ActionItem[] = []
      const suggestions: SuggestionItem[] = []

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const json = line.slice(6).trim()
          if (!json || json === '[DONE]') continue

          try {
            const event = JSON.parse(json)
            switch (event.type) {
              case 'session_started':
                // 可选：更新 convId
                break

              case 'intent_detected':
                updateLastAssistant(() => ({ intent: event.intent }))
                break

              case 'guardrail_blocked':
                updateLastAssistant(() => ({
                  blockedData: {
                    content: event.content,
                    officialLinks: event.officialLinks,
                    suggestions: event.suggestions,
                  },
                  isStreaming: false,
                }))
                break

              case 'search_started':
                updateLastAssistant(() => ({ statusMessage: event.message }))
                break

              case 'answer_chunk':
              case 'text':  // SE chat 后端使用 "text" 类型（与 answer_chunk 等价）
                assistantContent += event.content
                updateLastAssistant(() => ({ content: assistantContent, statusMessage: undefined }))
                break

              case 'search_results':
                updateLastAssistant(() => ({
                  searchResults: { total: event.total, items: event.items, moreUrl: event.moreUrl },
                }))
                break

              case 'task_list':
                updateLastAssistant(() => ({ taskList: event.tasks }))
                break

              case 'web_search_started':
                updateLastAssistant(() => ({ statusMessage: event.message }))
                break

              case 'web_search_results':
                updateLastAssistant(() => ({ webSearchResults: { items: event.items, note: event.note } }))
                break

              case 'confidence_marker':
                // 三级置信度标签：🟢 本地标准库 / 🟡 联网搜索 / 🔴 AI 推断
                // 渲染在 message 顶部，由 ChatMessage.tsx 读取展示
                updateLastAssistant(() => ({
                  confidence: { level: event.level, emoji: event.emoji, label: event.label },
                }))
                break

              case 'action_suggested':
                if (event.action === 'send_message') {
                  suggestions.push({ text: event.text, label: event.label })
                  updateLastAssistant(() => ({ suggestions: [...suggestions] }))
                } else {
                  // Web 端不渲染 /pages/ 开头的小程序路径
                  if (event.url && !event.url.startsWith('/pages/')) {
                    actions.push({ action: event.action, url: event.url, label: event.label })
                    updateLastAssistant(() => ({ actions: [...actions] }))
                  }
                }
                break

              case 'quota_info':
                setQuotaTier(event.tier)
                setRemainingQuota(event.remaining)
                break

              case 'conversation_updated':
                setConversations(prev =>
                  prev.map(c => c.id === event.conversationId ? { ...c, title: event.title } : c),
                )
                break

              case 'outline_done':
                updateLastAssistant(() => ({ showOutlineActions: true, outlineTier: quotaTier }))
                break

              case 'framework_done':
                updateLastAssistant(() => ({ showFrameworkDownload: true }))
                break

              case 'verified_references':
                updateLastAssistant(() => ({
                  verifiedReferences: {
                    verified: event.verified || [],
                    unverified: event.unverified || [],
                    total: event.total || 0,
                  },
                }))
                break

              case 'done':
                break

              case 'error':
                assistantContent += event.message || '出错了，请稍后重试'
                updateLastAssistant(() => ({ content: assistantContent }))
                break
            }
          } catch { /* 忽略解析错误 */ }
        }
      }

      // 流式结束
      updateLastAssistant(() => ({
        content: assistantContent,
        isStreaming: false,
        actions: actions.length > 0 ? actions : undefined,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
      }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      if (err.name === 'AbortError') return
      console.error('SSE 请求失败', err)
      // 指数退避重试（最多 2 次）
      if (_retryCount < MAX_RETRIES) {
        const delay = Math.pow(2, _retryCount) * 1000
        updateLastAssistant(() => ({ statusMessage: `网络异常，${delay / 1000}秒后重试...` }))
        await new Promise(r => setTimeout(r, delay))
        return processSSE(url, body, _retryCount + 1)
      }
      updateLastAssistant(() => ({
        content: '网络连接失败，请检查网络后重试。',
        isStreaming: false,
      }))
    } finally {
      setIsStreaming(false)
      abortRef.current = null
    }
  }, [updateLastAssistant, quotaTier])

  // ─── 发送消息 ────────────────────────────────────────────

  const sendMessage = useCallback(async (message: string, convId?: string) => {
    let targetConvId = convId || currentConvId
    if (!message.trim() || isStreaming) return

    // 延迟创建：如果没有当前会话，先创建
    if (!targetConvId) {
      targetConvId = await doCreateConversation()
      if (!targetConvId) return
    }

    const userMsg: Message = { role: 'user', content: message }
    const assistantMsg: Message = { role: 'assistant', content: '', isStreaming: true }
    setMessages(prev => [...prev, userMsg, assistantMsg])
    setIsStreaming(true)

    // 前端兜底：第一条消息时立即设置临时标题
    const isFirstMessage = messages.length === 0
    if (isFirstMessage) {
      const tempTitle = message.length > 20 ? message.slice(0, 20) + '...' : message
      setConversations(prev =>
        prev.map(c => c.id === targetConvId ? { ...c, title: tempTitle } : c),
      )
    }

    await processSSE(`${chatBase}/send`, { conversationId: targetConvId, message })

    // 刷新会话列表（标题可能更新了）
    loadConversations()
  }, [currentConvId, messages.length, isStreaming, processSSE, loadConversations, doCreateConversation])

  // ─── 确认大纲，生成框架 ──────────────────────────────────

  const confirmOutline = useCallback(async (outlineContent: string) => {
    if (!currentConvId || isStreaming) return

    // 隐藏大纲按钮
    setMessages(prev => prev.map(m =>
      m.showOutlineActions ? { ...m, showOutlineActions: false } : m,
    ))

    const userMsg: Message = { role: 'user', content: '确认大纲，生成标准框架' }
    const assistantMsg: Message = { role: 'assistant', content: '', isStreaming: true }
    setMessages(prev => [...prev, userMsg, assistantMsg])
    setIsStreaming(true)

    await processSSE('/api/app/chat/std-generate', { conversationId: currentConvId, outline: outlineContent })
  }, [currentConvId, isStreaming, processSSE])

  // 删除会话
  const deleteConversation = useCallback(async (convId: string) => {
    try {
      await (chatBase !== '/api/app/chat' ? nodeApi.delete(`${chatBase}/conversations/${convId}`) : _deleteConversationApi(convId))
      setConversations(prev => prev.filter(c => c.id !== convId))
      if (currentConvId === convId) {
        setCurrentConvId(null)
        setMessages([])
      }
    } catch (err) {
      console.error('删除会话失败', err)
      antMsg.error('删除会话失败')
    }
  }, [currentConvId])

  const renameConversation = useCallback(async (convId: string, title: string) => {
    const nextTitle = title.trim()
    if (!nextTitle) {
      antMsg.warning('对话名称不能为空')
      return false
    }
    try {
      const updated = await (chatBase !== '/api/app/chat'
        ? nodeApi.patch(`${chatBase}/conversations/${convId}`, { title: nextTitle })
        : _renameConversationApi(convId, nextTitle)) as { title: string; updatedAt: string }
      setConversations(prev =>
        prev.map(c => c.id === convId ? { ...c, title: updated.title, updatedAt: updated.updatedAt } : c),
      )
      return true
    } catch (err) {
      console.error('重命名会话失败', err)
      antMsg.error('重命名会话失败')
      return false
    }
  }, [])

  return {
    conversations,
    currentConvId,
    messages,
    isStreaming,
    isLoadingHistory,
    remainingQuota,
    quotaTier,
    loadConversations,
    switchConversation,
    createNewConversation,
    sendMessage,
    confirmOutline,
    deleteConversation,
    renameConversation,
    setCurrentConvId,
  }
}
