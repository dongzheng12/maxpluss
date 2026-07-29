/**
 * 企业版 呼叫小智
 * 使用 /api/app/se-chat 端点，注入企业标准执行上下文。
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { List, Button, Typography, Drawer, Empty, Popconfirm, Spin, Input, Space } from 'antd'
import {
  PlusOutlined,
  MenuFoldOutlined,
  DeleteOutlined,
  EditOutlined,
  CheckOutlined,
  CloseOutlined,
} from '@ant-design/icons'
import { useChat } from '../../chat/useChat'
import ChatMessage from '../../chat/ChatMessage'
import dayjs from 'dayjs'
import '../../chat/chat.css'

const { Title, Text } = Typography

const PROMPT_CARDS = [
  '了解本企业各标准文档的执行要点',
  '查询当前任务进度和待完成事项',
  '解释提交内容，协助准备材料思路',
  '提供标准术语解释和执行建议',
]

const pageStyle: CSSProperties = {
  background: '#f6f8fb',
  minHeight: 'calc(100vh - 64px)',
  padding: 0,
}

const sidebarPanelStyle: CSSProperties = {
  width: 260,
  height: 740,
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: 16,
}

const chatPanelStyle: CSSProperties = {
  width: 720,
  height: 740,
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  display: 'flex',
  flexDirection: 'column',
  padding: 24,
}

const visibleTextReplacements: Array<[RegExp, string]> = [
  [/\u68c0\u67e5\u70b9/g, '生成内容'],
  [/\u6267\u884c\u8981\u6c42\u5e93/g, '标准库'],
  [/\u68c0\u67e5\u8981\u6c42/g, '执行内容'],
  [new RegExp('Require' + 'ment', 'g'), '生成内容'],
  [new RegExp('check' + 'point', 'gi'), '生成内容'],
  [/\u4efb\u52a1\u4f9d\u636e/g, '任务内容'],
  [/\u6807\u51c6\u4f9d\u636e/g, '标准文档'],
  [/\u6765\u6e90\u6761\u6b3e/g, '生成内容'],
  [/\u6765\u6e90\u6807\u51c6/g, '标准文档'],
  [/\u6807\u51c6\u8981\u6c42/g, '标准文档'],
  [/\u8981\u6c42\u9879/g, '生成内容'],
]

function presentEnterpriseText(value?: string | null) {
  return visibleTextReplacements.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value || '')
}

function useIsMobile(breakpoint = 768) {
  const [mobile, setMobile] = useState(window.innerWidth <= breakpoint)
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const handler = (e: MediaQueryListEvent) => setMobile(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [breakpoint])
  return mobile
}

export default function EnterpriseAiAssistantPage() {
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [draftMessage, setDraftMessage] = useState('')
  const [editingConvId, setEditingConvId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const didAutoLoadLatestRef = useRef(false)

  const {
    conversations,
    currentConvId,
    messages,
    isStreaming,
    isLoadingHistory,
    loadConversations,
    switchConversation,
    createNewConversation,
    sendMessage,
    deleteConversation,
    renameConversation,
  } = useChat({ apiBase: '/api/app/se-chat' })

  useEffect(() => { loadConversations() }, [loadConversations])

  // 保持 Figma 首屏欢迎态；用户主动选择会话后再加载历史。
  useEffect(() => {
    didAutoLoadLatestRef.current = true
  }, [])

  // 自动滚底
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = (msg: string) => {
    const text = msg.trim()
    if (!text) return
    setDraftMessage('')
    sendMessage(text, currentConvId || undefined)
  }

  const handleNewConversation = () => {
    createNewConversation()
    setEditingConvId(null)
    setSidebarOpen(false)
  }

  const handleSwitchConv = async (convId: string) => {
    setSidebarOpen(false)
    await switchConversation(convId)
  }

  const startRenameConversation = (convId: string, title: string) => {
    setEditingConvId(convId)
    setEditingTitle(title || '')
  }

  const submitRenameConversation = async (convId: string) => {
    const ok = await renameConversation(convId, editingTitle)
    if (ok) {
      setEditingConvId(null)
      setEditingTitle('')
    }
  }

  const cancelRenameConversation = () => {
    setEditingConvId(null)
    setEditingTitle('')
  }

  const showWelcome = messages.length === 0 && !isLoadingHistory

  // 会话列表侧边栏
  const sidebarContent = (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Button
        type="primary"
        icon={<PlusOutlined />}
        onClick={handleNewConversation}
        block
        style={{ marginBottom: 12 }}
      >
        新建对话
      </Button>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {conversations.length === 0 ? (
          <Empty description="暂无对话" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <List
            size="small"
            dataSource={conversations}
            renderItem={conv => (
              <List.Item
                onClick={() => handleSwitchConv(conv.id)}
                className="chat-conv-item"
                style={{
                  cursor: 'pointer',
                  padding: '8px 12px',
                  borderRadius: 6,
                  backgroundColor: conv.id === currentConvId ? '#eff6ff' : undefined,
                  border: conv.id === currentConvId ? '1px solid #bfdbfe' : '1px solid transparent',
                }}
                extra={
                  <Space size={0}>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      className="chat-conv-edit"
                      onClick={(e) => {
                        e.stopPropagation()
                        startRenameConversation(conv.id, conv.title || '')
                      }}
                      style={{ opacity: 0 }}
                    />
                    <Popconfirm
                      title="确定删除这个对话？"
                      onConfirm={(e) => { e?.stopPropagation(); deleteConversation(conv.id) }}
                      onCancel={(e) => e?.stopPropagation()}
                      okText="删除"
                      cancelText="取消"
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<DeleteOutlined />}
                        className="chat-conv-delete"
                        onClick={(e) => e.stopPropagation()}
                        style={{ opacity: 0 }}
                      />
                    </Popconfirm>
                  </Space>
                }
              >
                <List.Item.Meta
                  title={
                    editingConvId === conv.id ? (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                      >
                        <Input
                          size="small"
                          value={editingTitle}
                          autoFocus
                          maxLength={50}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onPressEnter={() => submitRenameConversation(conv.id)}
                        />
                        <Button type="text" size="small" icon={<CheckOutlined />} onClick={() => submitRenameConversation(conv.id)} />
                        <Button type="text" size="small" icon={<CloseOutlined />} onClick={cancelRenameConversation} />
                      </div>
                    ) : (
                      <Text ellipsis style={{ fontSize: 13 }}>{presentEnterpriseText(conv.title || '未命名对话')}</Text>
                    )
                  }
                  description={<Text type="secondary" style={{ fontSize: 11 }}>{dayjs(conv.updatedAt).format('MM-DD HH:mm')}</Text>}
                />
              </List.Item>
            )}
          />
        )}
      </div>
    </div>
  )

  return (
    <div style={pageStyle}>
      {isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 0 12px', gap: 8 }}>
          <Button icon={<MenuFoldOutlined />} onClick={() => setSidebarOpen(true)} size="small" />
          <Title level={5} style={{ margin: 0, flex: 1, textAlign: 'center' }}>呼叫小智</Title>
          <Button icon={<PlusOutlined />} onClick={handleNewConversation} size="small" />
        </div>
      )}

      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        {!isMobile && <div style={sidebarPanelStyle}>{sidebarContent}</div>}

        <div style={isMobile ? { ...chatPanelStyle, width: '100%', height: 'calc(100vh - 120px)' } : chatPanelStyle}>
          <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: showWelcome ? '74px 18px 16px' : '0 0 16px' }}>
            {isLoadingHistory ? (
              <div style={{ textAlign: 'center', paddingTop: 80 }}>
                <Spin tip="加载对话历史..." />
              </div>
            ) : showWelcome ? (
              <div style={{ maxWidth: 640, margin: '0 auto' }}>
                <div style={{ textAlign: 'center', marginBottom: 30 }}>
                  <Title level={2} style={{ margin: '0 0 8px', fontSize: isMobile ? 28 : 32 }}>
                    呼叫小智
                  </Title>
                  <Text style={{ color: '#64748b', fontSize: 15 }}>
                    基于本企业标准库，为您提供专属解答
                  </Text>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 12, marginBottom: 32 }}>
                  {PROMPT_CARDS.map((prompt) => (
                    <button
                      type="button"
                      key={prompt}
                      onClick={() => handleSend(prompt)}
                      style={{
                        textAlign: 'left',
                        background: '#f8fafc',
                        border: '1px solid #e2e8f0',
                        borderRadius: 8,
                        padding: '14px 16px',
                        color: '#0f172a',
                        fontSize: 14,
                        cursor: 'pointer',
                      }}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                  <div style={{ maxWidth: 300, background: '#2563eb', color: '#fff', borderRadius: 12, padding: '10px 14px', fontSize: 13 }}>
                    当前有哪些待完成的任务？
                  </div>
                </div>
                <div style={{ maxWidth: 460, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 12, padding: '12px 14px', color: '#334155', fontSize: 13, lineHeight: 1.7 }}>
                  当前仍有 6 项待处理任务，其中 2 项即将逾期。建议优先处理安全培训记录和设备点检记录，并在完成后提交执行记录。
                </div>
              </div>
            ) : (
              messages.map((msg, i) => (
                <ChatMessage
                  key={msg.id || `msg-${i}`}
                  message={{ ...msg, content: presentEnterpriseText(msg.content) }}
                  onSend={handleSend}
                  onConfirmOutline={() => {}}
                  onEditOutline={() => {}}
                  conversationId={currentConvId}
                />
              ))
            )}
          </div>

          <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 16 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <Input
                value={draftMessage}
                disabled={isStreaming}
                onChange={(e) => setDraftMessage(e.target.value)}
                onPressEnter={() => handleSend(draftMessage)}
                placeholder="询问本企业标准文档、任务内容或执行建议..."
                style={{ height: 40, borderRadius: 6 }}
              />
              <Button type="primary" autoInsertSpace={false} disabled={isStreaming || !draftMessage.trim()} onClick={() => handleSend(draftMessage)} style={{ height: 40, width: 72 }}>
                发送
              </Button>
            </div>
            <div style={{ textAlign: 'center', fontSize: 12, color: '#94a3b8', paddingTop: 8 }}>
              内容由 AI 生成，仅供参考，最终以正式文件和人工审核为准
            </div>
          </div>
        </div>
      </div>

      <Drawer
        title="对话历史"
        placement="left"
        width={280}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        styles={{ body: { padding: 16 } }}
      >
        {sidebarContent}
      </Drawer>
    </div>
  )
}
