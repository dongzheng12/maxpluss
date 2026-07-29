import { useEffect, useRef, useState, useMemo } from 'react'
import { Row, Col, List, Button, Typography, Card, Drawer, Empty, Popconfirm, Spin, Input, Space } from 'antd'
import { PlusOutlined, MenuFoldOutlined, DeleteOutlined, EditOutlined, CheckOutlined, CloseOutlined } from '@ant-design/icons'
import { useLocation } from 'react-router-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useChat } from './useChat'
import ChatMessage from './ChatMessage'
import ChatInput from './ChatInput'
import dayjs from 'dayjs'
import './chat.css'

const { Title, Text, Paragraph } = Typography

const EXAMPLE_QUESTIONS = [
  '关于食品安全有哪些现行国标？',
  '帮我编写一个电子产品可靠性试验标准',
  'GB/T 1.1-2020 是什么标准？',
  '查一下焊接相关的标准',
  '有没有关于新能源汽车的标准？',
  '帮我比对两个文档',
]

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

export default function ChatPage() {
  const { isLoggedIn } = useAuth()
  const location = useLocation()
  const isMobile = useIsMobile()
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [draftMessage, setDraftMessage] = useState('')
  const [inputFocusTrigger, setInputFocusTrigger] = useState(0)
  const [editingConvId, setEditingConvId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const autoSentKeyRef = useRef<string | null>(null)
  const didAutoLoadLatestRef = useRef(false)

  const {
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
  } = useChat()

  // 随机选 2 个示例问题
  const examples = useMemo(() => {
    // eslint-disable-next-line react-hooks/purity
    const shuffled = [...EXAMPLE_QUESTIONS].sort(() => Math.random() - 0.5)
    return shuffled.slice(0, 2)
  }, [])

  useEffect(() => {
    if (isLoggedIn) loadConversations()
  }, [isLoggedIn, loadConversations])

  // 进入聊天页时自动加载最近一条对话（仅触发一次，避免覆盖用户「新建对话」意图）
  // - 有历史 → 切到最近一条
  // - 无历史 → 保持空白 welcome state，不自动创建
  // - URL 带 ask 参数（首页快捷问句）→ 不自动切入，让用户直接输入
  useEffect(() => {
    if (didAutoLoadLatestRef.current) return
    if (!isLoggedIn) return
    if (conversations.length === 0) return
    if (currentConvId) return
    const params = new URLSearchParams(location.search)
    if (params.get('ask')?.trim()) return
    didAutoLoadLatestRef.current = true
    void switchConversation(conversations[0].id)
  }, [isLoggedIn, conversations, currentConvId, location.search, switchConversation])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const ask = params.get('ask')?.trim()
    if (!ask) return
    setDraftMessage(ask)
    setInputFocusTrigger(prev => prev + 1)
  }, [location.search])

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const ask = params.get('ask')?.trim()
    const autoSend = params.get('autoSend') === '1'
    if (!ask || !autoSend || !isLoggedIn) return
    // 只基于 URL 去重，不随 currentConvId 变化重复发送
    const key = `${location.search}|${isLoggedIn}`
    if (autoSentKeyRef.current === key) return
    autoSentKeyRef.current = key
    setDraftMessage('')
    void sendMessage(ask, currentConvId || undefined)
  }, [location.search, isLoggedIn, sendMessage])

  // 自动滚底
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = async (msg: string) => {
    if (!isLoggedIn) {
      // eslint-disable-next-line react-hooks/immutability
      window.location.href = '/login?redirect=/chat'
      return
    }
    setDraftMessage('')
    sendMessage(msg, currentConvId || undefined)
  }

  const handleEditOutline = (outlineContent: string) => {
    const nextDraft = `请基于下面这个大纲帮我修改。\n\n${outlineContent}\n\n我的修改要求是：`
    setDraftMessage(nextDraft)
    setInputFocusTrigger(prev => prev + 1)
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

  const isFree = quotaTier === 'free'
  const quotaExhausted = isFree && remainingQuota === 0
  const showWelcome = messages.length === 0 && !isLoadingHistory

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

  // 会话列表侧边栏内容
  const sidebarContent = (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Button
        type="dashed"
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
                  backgroundColor: conv.id === currentConvId ? '#e6f4ff' : undefined,
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
                      <Text ellipsis style={{ fontSize: 13 }}>{conv.title || '未命名对话'}</Text>
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
    <div style={{ height: 'calc(100vh - 140px)', display: 'flex', flexDirection: 'column' }}>
      {/* 移动端顶栏 */}
      {isMobile && (
        <div style={{ display: 'flex', alignItems: 'center', padding: '0 0 8px', gap: 8 }}>
          <Button
            icon={<MenuFoldOutlined />}
            onClick={() => setSidebarOpen(true)}
            size="small"
          />
          <Title level={5} style={{ margin: 0, flex: 1, textAlign: 'center' }}>呼叫小智</Title>
          <Button icon={<PlusOutlined />} onClick={handleNewConversation} size="small" />
        </div>
      )}

      <Row style={{ flex: 1, overflow: 'hidden' }} gutter={16}>
        {/* 桌面端侧边栏 */}
        {!isMobile && (
          <Col span={5} style={{ height: '100%', borderRight: '1px solid #f0f0f0', paddingRight: 16 }}>
            {sidebarContent}
          </Col>
        )}

        {/* 聊天主区域 */}
        <Col span={isMobile ? 24 : 19} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
          {/* 消息列表 */}
          <div
            ref={scrollRef}
            style={{ flex: 1, overflowY: 'auto', padding: '16px 0 8px' }}
          >
            {isLoadingHistory ? (
              <div style={{ textAlign: 'center', paddingTop: 80 }}>
                <Spin tip="加载对话历史..." />
              </div>
            ) : showWelcome ? (
              <div style={{ paddingTop: isMobile ? 20 : 32, maxWidth: 980, margin: '0 auto' }}>
                <div style={{ textAlign: 'center', margin: '0 auto 28px', maxWidth: 760 }}>
                  <div
                    style={{
                      width: isMobile ? 80 : 96,
                      height: isMobile ? 80 : 96,
                      margin: '0 auto 18px',
                    }}
                  >
                    <img
                      src="/xiaozhi-hero.png"
                      alt="呼叫小智机器人"
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    />
                  </div>
                  <Title level={1} style={{ marginBottom: 8, fontSize: isMobile ? 34 : 42 }}>
                    Hi，我是标准小智
                  </Title>
                  <Paragraph style={{ color: '#8c8c8c', fontSize: isMobile ? 18 : 20, marginBottom: 22 }}>
                    您身边的标准化 AI 助手
                  </Paragraph>
                  <div style={{ display: 'inline-block', textAlign: 'left' }}>
                    <Paragraph style={{ color: '#8c8c8c', fontSize: 16, marginBottom: 8 }}>
                      我可以帮您：
                    </Paragraph>
                    <Paragraph style={{ color: '#8c8c8c', fontSize: 16, marginBottom: 4 }}>
                      🔍 查询标准信息（标准号、状态、行业分类等）
                    </Paragraph>
                    <Paragraph style={{ color: '#8c8c8c', fontSize: 16, marginBottom: 4 }}>
                      📝 辅助编写标准文本框架
                    </Paragraph>
                    <Paragraph style={{ color: '#8c8c8c', fontSize: 16, marginBottom: 4 }}>
                      📊 发起文档比对分析
                    </Paragraph>
                    <Paragraph style={{ color: '#8c8c8c', fontSize: 16, marginBottom: 0 }}>
                      📋 查看会员权益与订单状态
                    </Paragraph>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', padding: '0 8px' }}>
                  {examples.map((q, i) => (
                    <Card
                      key={i}
                      hoverable={!quotaExhausted}
                      size="small"
                      onClick={() => !quotaExhausted && handleSend(q)}
                      style={{
                        maxWidth: 280, textAlign: 'left', borderRadius: 12,
                        opacity: quotaExhausted ? 0.5 : 1,
                        cursor: quotaExhausted ? 'not-allowed' : 'pointer',
                        borderColor: '#dbe7ff',
                        boxShadow: '0 8px 20px rgba(34, 76, 156, 0.06)',
                      }}
                    >
                      <Text style={{ fontSize: 13 }}>{q}</Text>
                    </Card>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg, i) => (
                <ChatMessage
                  key={msg.id || `msg-${i}`}
                  message={msg}
                  onSend={handleSend}
                  onConfirmOutline={(outline) => confirmOutline(outline)}
                  onEditOutline={handleEditOutline}
                  conversationId={currentConvId}
                />
              ))
            )}
          </div>

          {/* 额度提示 */}
          {isFree && isLoggedIn && remainingQuota !== null && (
            <div style={{ textAlign: 'center', padding: '6px 0 2px' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                今日剩余 {remainingQuota}/5 次对话
                {remainingQuota <= 0 && (
                  <a href="/membership" style={{ marginLeft: 8 }}>升级会员</a>
                )}
              </Text>
            </div>
          )}

          {/* 输入框 */}
          <div style={{ maxWidth: 980, width: '100%', margin: '0 auto', position: 'relative' }}>
            <ChatInput
              onSend={handleSend}
              disabled={isStreaming || quotaExhausted}
              value={draftMessage}
              onChange={setDraftMessage}
              autoFocusTrigger={inputFocusTrigger}
              placeholder={
                !isLoggedIn ? '请先登录后使用' :
                (remainingQuota === 0 ? '今日免费额度已用完' : '输入标准号、关键词，或直接描述您的问题')
              }
            />
            <div style={{
              textAlign: 'center',
              fontSize: 14,
              color: '#8c8c8c',
              padding: '4px 0 12px',
              letterSpacing: 0.2,
            }}>
              内容由 AI 生成，仅供参考
            </div>
          </div>
        </Col>
      </Row>

      {/* 移动端侧边栏 Drawer */}
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
