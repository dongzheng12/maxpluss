/**
 * SEAIFloatingBubble — 标准执行 AI 浮标
 * 可拖拽浮标按钮，点击弹出抽屉式 AI 助手，使用 /api/app/se-chat 端点。
 * 根据当前页面路径自动显示上下文快捷问题。
 */

import { useState, useRef, useCallback, useEffect, useContext } from 'react'
import { useLocation } from 'react-router-dom'
import { SEPageContext } from '../contexts/SEPageContext'
import { isSERoute } from '../utils/seRoutes'
import {
  Drawer,
  Input,
  Button,
  Space,
  Typography,
  Avatar,
  Spin,
  Tag,
  Divider,
  Tooltip,
} from 'antd'
import {
  RobotOutlined,
  SendOutlined,
  CloseOutlined,
  ClearOutlined,
  ThunderboltOutlined,
  AimOutlined,
} from '@ant-design/icons'
import {
  AIPageContentPicker,
  buildAIAskPayload,
  useAIDisplayPreference,
} from './se/aiQuestioning'
import type { RegisteredAIAskable } from './se/aiQuestioning/askableRegistry'

const { Text } = Typography

const BASE = import.meta.env.DEV ? '/node-api' : ''
const SE_CHAT_API = '/api/app/se-chat'

// ─── 页面上下文快捷问题映射 ─────────────────────────────────────

const PAGE_CONTEXT: Record<string, { label: string; questions: string[] }> = {
  dashboard: {
    label: '执行总览',
    questions: [
      '总结今日的合规执行状态',
      '当前最紧急的合规风险是什么？',
      '本周完成情况如何，有哪些亮点？',
      '哪些任务即将逾期，需要立即关注？',
    ],
  },
  sources: {
    label: '标准库',
    questions: [
      '这个标准最重要的要求有哪些？',
      '建议优先解析哪些条款？',
      '如何高效导入标准并生成执行任务？',
      '国内常用的安全/质量标准有哪些推荐？',
    ],
  },
  requirements: {
    label: '生成内容',
    questions: [
      '请解释这条生成内容的含义和执行要点',
      '这条要求需要员工提交什么材料？',
      '建议把这条要求分配给哪个部门执行？',
      '如何将生成内容分解成可落地的任务？',
    ],
  },
  tasks: {
    label: '执行任务',
    questions: [
      '分析当前任务的整体完成率',
      '找出最危险的逾期任务',
      '哪些任务的审核材料最容易出问题？',
      '如何提高员工任务完成的积极性？',
    ],
  },
  reviews: {
    label: '合规审核台',
    questions: [
      '分析当前审核积压情况',
      '建议优先处理哪些审核？',
      '审核驳回率较高说明什么问题？',
      '如何提升审核效率？',
    ],
  },
  records: {
    label: '完成记录',
    questions: [
      '哪些完成记录适合放入审计包？',
      '当前记录的质量整体如何？',
      '如何避免记录被作废？',
      'EXPIRED 状态的记录怎么处理？',
    ],
  },
  packages: {
    label: '审计包',
    questions: [
      '分析审计包的完整性和覆盖率',
      '哪些生成内容还没有对应的材料？',
      '审计包生成后如何向客户展示？',
      '如何处理含无效记录的审计包？',
    ],
  },
  risks: {
    label: '风险看板',
    questions: [
      '最紧急需要处理哪个风险？',
      '给出高危风险的整改建议',
      '风险等级如何评定？',
      '如何从根本上降低合规风险？',
    ],
  },
}

function getPageContext(pathname: string) {
  const segments = pathname.split('/')
  const last = segments[segments.length - 1]
  return PAGE_CONTEXT[last] ?? PAGE_CONTEXT['dashboard']
}

// ─── 消息类型 ──────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  isStreaming?: boolean
}

// ─── 浮标拖拽逻辑 ─────────────────────────────────────────────

interface DragPos { x: number; y: number }

function useDraggable(initialPos: DragPos) {
  const [pos, setPos] = useState<DragPos>(initialPos)
  const dragging = useRef(false)
  const startMouse = useRef<DragPos>({ x: 0, y: 0 })
  const startPos = useRef<DragPos>(initialPos)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startMouse.current = { x: e.clientX, y: e.clientY }
    startPos.current = pos

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      setPos({
        x: startPos.current.x + ev.clientX - startMouse.current.x,
        y: startPos.current.y + ev.clientY - startMouse.current.y,
      })
    }
    const onMouseUp = () => {
      dragging.current = false
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [pos])

  return { pos, onMouseDown }
}

// ─── 主组件 ───────────────────────────────────────────────────

export default function SEAIFloatingBubble() {
  const location = useLocation()
  const pageCtx = getPageContext(location.pathname)
  const { data: pageData, ask } = useContext(SEPageContext)
  const { enabled: aiDisplayEnabled } = useAIDisplayPreference()

  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [picking, setPicking] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 默认右下角，距边 24px
  const { pos, onMouseDown } = useDraggable({ x: window.innerWidth - 80, y: window.innerHeight - 100 })

  // 自动滚到底
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // 导航到新页面时浮标恢复（× 关闭仅对当前页生效，换页/刷新会再出来）
  useEffect(() => {
    setDismissed(false)
    setPicking(false)
  }, [location.pathname])

  const sendMessage = useCallback(async (text: string, contextOverride?: string) => {
    if (!text.trim() || streaming) return
    setInput('')

    const userMsg: ChatMessage = { role: 'user', content: text }
    const placeholderMsg: ChatMessage = { role: 'assistant', content: '', isStreaming: true }
    setMessages(prev => [...prev, userMsg, placeholderMsg])
    setStreaming(true)

    if (abortRef.current) abortRef.current.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const token = localStorage.getItem('bxz_token')
      const contextHint = contextOverride
        ? `\n\n【当前业务上下文】\n${contextOverride}\n\n（请基于以上上下文回答用户问题，不要臆造上下文之外的数据；并在回答末尾另起一行注明：仅供参考，最终以人工审核为准）`
        : pageData
          ? `\n\n【当前页面数据】\n${pageData.summary}`
          : `\n\n（当前页面：${pageCtx.label}）`
      const response = await fetch(`${BASE}${SE_CHAT_API}/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: text + contextHint }),
        signal: controller.signal,
      })

      if (!response.ok) {
        const errJson = await response.json().catch(() => ({}))
        throw new Error((errJson as { error?: string }).error || `HTTP ${response.status}`)
      }

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let assistantContent = ''

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
            if (event.type === 'text' && event.content) {
              assistantContent += event.content
              setMessages(prev => {
                const updated = [...prev]
                const last = updated[updated.length - 1]
                if (last?.role === 'assistant') {
                  updated[updated.length - 1] = { ...last, content: assistantContent }
                }
                return updated
              })
            }
          } catch { /* ignore parse errors */ }
        }
      }

      // 流完成：清除 streaming 标记
      setMessages(prev => {
        const updated = [...prev]
        const last = updated[updated.length - 1]
        if (last?.role === 'assistant') {
          updated[updated.length - 1] = { ...last, isStreaming: false }
        }
        return updated
      })
    } catch (err: unknown) {
      const errMsg = err instanceof Error && err.name !== 'AbortError'
        ? (err.message || '请求失败，请重试')
        : ''
      if (errMsg) {
        setMessages(prev => {
          const updated = [...prev]
          const last = updated[updated.length - 1]
          if (last?.role === 'assistant') {
            updated[updated.length - 1] = { ...last, content: errMsg, isStreaming: false }
          }
          return updated
        })
      }
    } finally {
      setStreaming(false)
    }
  }, [streaming, pageCtx.label, pageData])

  // P1-8: 详情页「问小智」触发 → 打开抽屉 + 携带当前对象上下文发送预设问题
  const askNonceRef = useRef(0)
  useEffect(() => {
    if (ask && ask.nonce !== askNonceRef.current) {
      askNonceRef.current = ask.nonce
      setOpen(true)
      sendMessage(ask.question, ask.contextText)
    }
  }, [ask, sendMessage])

  const handlePickAskable = useCallback((entry: RegisteredAIAskable) => {
    setOpen(true)
    const payload = buildAIAskPayload(entry.context, entry.question)
    sendMessage(payload.question, payload.contextText)
  }, [sendMessage])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  const handleClear = () => {
    if (abortRef.current) abortRef.current.abort()
    setMessages([])
    setStreaming(false)
    setInput('')
  }

  // 非 SE/企业版路由不渲染浮标（hooks 已全部在上方无条件执行，此处守卫不破坏 hooks 顺序）
  if (!isSERoute(location.pathname) || !aiDisplayEnabled) return null

  return (
    <>
      <AIPageContentPicker
        active={picking}
        onPick={handlePickAskable}
        onCancel={() => setPicking(false)}
      />

      {/* ─── 浮标按钮 ─── */}
      {!dismissed && (
      // 外层 wrapper 扩大 hover 感知区，确保 × 按钮（top:-6 right:-6）在 hover 区内不丢失
      <div
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        style={{
          position: 'fixed',
          left: pos.x - 8,
          top: pos.y - 8,
          zIndex: 1000,
          padding: '8px 14px 8px 8px',
        }}
      >
      <div
        onMouseDown={onMouseDown}
        onClick={() => setOpen(true)}
        style={{
          position: 'relative',
          width: 52,
          height: 52,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
          boxShadow: isHovered ? '0 6px 24px rgba(102,126,234,0.7)' : '0 4px 16px rgba(102,126,234,0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'grab',
          userSelect: 'none',
          transition: 'box-shadow 0.2s',
        }}
      >
        <Tooltip title="小智 AI 助手" placement="left">
          <RobotOutlined style={{ fontSize: 24, color: '#fff' }} />
        </Tooltip>
        {/* 在线小绿点 */}
        <span style={{
          position: 'absolute',
          top: 4,
          right: 4,
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: '#52c41a',
          border: '2px solid #fff',
        }} />
        {/* hover 时显示关闭按钮，关闭后当前页隐藏，换页/刷新恢复 */}
        {isHovered && (
          <div
            onClick={(e) => { e.stopPropagation(); setDismissed(true); setOpen(false); setPicking(false) }}
            style={{ position: 'absolute', top: -6, right: -6, width: 16, height: 16, borderRadius: '50%', background: '#888', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, lineHeight: 1, cursor: 'pointer', border: '1px solid #fff' }}
          >×</div>
        )}
      </div>
      </div>
      )}

      {/* ─── AI 抽屉 ─── */}
      <Drawer
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Avatar
              size={28}
              style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}
              icon={<RobotOutlined />}
            />
            <div>
              <div style={{ fontWeight: 600, lineHeight: 1.2 }}>小智 AI 助手</div>
              <div style={{ fontSize: 11, color: '#999', lineHeight: 1.2 }}>
                当前：{pageCtx.label}
              </div>
            </div>
          </div>
        }
        placement="right"
        width={420}
        open={open}
        onClose={() => { setOpen(false); setPicking(false) }}
        closeIcon={<CloseOutlined />}
        mask={false}
        style={{ top: 0 }}
        styles={{
          body: { padding: 0, display: 'flex', flexDirection: 'column', height: '100%' },
          header: { borderBottom: '1px solid #f0f0f0', padding: '12px 16px' },
        }}
        extra={
          <Space size={4}>
            <Tooltip title="选取页面内容提问">
              <Button
                type={picking ? 'primary' : 'text'}
                size="small"
                icon={<AimOutlined />}
                onClick={() => setPicking((v) => !v)}
                disabled={streaming}
              />
            </Tooltip>
            <Tooltip title="清空对话">
              <Button
                type="text"
                size="small"
                icon={<ClearOutlined />}
                onClick={handleClear}
                disabled={messages.length === 0}
              />
            </Tooltip>
          </Space>
        }
      >
        {/* ─── 快捷问题区 ─── */}
        {messages.length === 0 && (
          <div style={{ padding: '16px 16px 0' }}>
            <Button
              block
              icon={<AimOutlined />}
              onClick={() => setPicking(true)}
              disabled={streaming}
              style={{ marginBottom: 12, borderRadius: 10 }}
            >
              选取页面内容提问
            </Button>
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 10,
              color: '#666',
              fontSize: 12,
            }}>
              <ThunderboltOutlined style={{ color: '#faad14' }} />
              <span>快捷问题</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pageCtx.questions.map((q, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(q)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 12px',
                    border: '1px solid #e8e8e8',
                    borderRadius: 8,
                    background: '#fafafa',
                    cursor: 'pointer',
                    fontSize: 13,
                    color: '#333',
                    lineHeight: 1.5,
                    transition: 'all 0.15s',
                  }}
                  onMouseEnter={e => {
                    const el = e.currentTarget
                    el.style.background = '#f0f0ff'
                    el.style.borderColor = '#d0d0ff'
                  }}
                  onMouseLeave={e => {
                    const el = e.currentTarget
                    el.style.background = '#fafafa'
                    el.style.borderColor = '#e8e8e8'
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
            <Divider style={{ margin: '16px 0 0' }} />
          </div>
        )}

        {/* ─── 消息列表 ─── */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}>
          {messages.map((msg, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
                alignItems: 'flex-start',
                gap: 8,
              }}
            >
              {msg.role === 'assistant' && (
                <Avatar
                  size={28}
                  style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)', flexShrink: 0 }}
                  icon={<RobotOutlined />}
                />
              )}
              <div
                style={{
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: msg.role === 'user' ? '12px 2px 12px 12px' : '2px 12px 12px 12px',
                  background: msg.role === 'user' ? '#667eea' : '#f5f5f5',
                  color: msg.role === 'user' ? '#fff' : '#333',
                  fontSize: 13,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {msg.isStreaming && !msg.content ? (
                  <Spin size="small" />
                ) : (
                  msg.content
                )}
                {msg.isStreaming && msg.content && (
                  <span style={{ display: 'inline-block', width: 6, height: 14, background: '#667eea', marginLeft: 2, verticalAlign: 'text-bottom', animation: 'blink 1s step-end infinite' }} />
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* ─── 输入区 ─── */}
        <div style={{
          padding: '12px 16px',
          borderTop: '1px solid #f0f0f0',
          background: '#fff',
        }}>
          {messages.length > 0 && (
            <div style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {pageCtx.questions.slice(0, 2).map((q, i) => (
                <Tag
                  key={i}
                  style={{ cursor: 'pointer', borderRadius: 12, fontSize: 11 }}
                  onClick={() => sendMessage(q)}
                >
                  {q.length > 16 ? q.slice(0, 16) + '…' : q}
                </Tag>
              ))}
            </div>
          )}
          <Space.Compact style={{ width: '100%' }}>
            <Input.TextArea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="输入问题，Shift+Enter 换行"
              autoSize={{ minRows: 1, maxRows: 4 }}
              disabled={streaming}
              style={{ borderRadius: '8px 0 0 8px', fontSize: 13, resize: 'none' }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={() => sendMessage(input)}
              loading={streaming}
              disabled={!input.trim() || streaming}
              style={{
                borderRadius: '0 8px 8px 0',
                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                border: 'none',
                height: 'auto',
              }}
            />
          </Space.Compact>
          <Text type="secondary" style={{ fontSize: 11, marginTop: 6, display: 'block' }}>
            由标准小智 AI 提供 · 仅供执行参考
          </Text>
        </div>
      </Drawer>

      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </>
  )
}
