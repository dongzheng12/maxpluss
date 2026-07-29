import { Avatar, Button, Space } from 'antd'
import { CheckOutlined, EditOutlined, FileTextOutlined } from '@ant-design/icons'
import Markdown from 'react-markdown'
import type { Message } from './useChat'
import SearchResultCard from './SearchResultCard'
import ActionButton from './ActionButton'
import SuggestionChip from './SuggestionChip'
import BlockedNotice from './BlockedNotice'
import StatusIndicator from './StatusIndicator'
import TaskStatusCard from './TaskStatusCard'

interface Props {
  message: Message
  onSend: (text: string) => void
  onConfirmOutline?: (outlineContent: string) => void
  onEditOutline?: (outlineContent: string) => void
  conversationId?: string | null
}

function downloadAsMarkdown(content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `标准框架_${new Date().toISOString().slice(0, 10)}.md`
  a.click()
  URL.revokeObjectURL(url)
}

async function downloadAsWord(conversationId: string, content: string, references?: Message['verifiedReferences']) {
  const BASE = import.meta.env.DEV ? '/node-api' : ''
  const token = localStorage.getItem('token') || ''
  try {
    const resp = await fetch(`${BASE}/api/app/chat/std-export-word`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ conversationId, content, references }),
    })
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: '导出失败' }))
      alert(err.error || '导出失败')
      return
    }
    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `标准框架_${new Date().toISOString().slice(0, 10)}.docx`
    a.click()
    URL.revokeObjectURL(url)
  } catch {
    alert('导出失败，请稍后重试')
  }
}

export default function ChatMessage({ message, onSend, onConfirmOutline, onEditOutline, conversationId }: Props) {
  const isUser = message.role === 'user'

  // blocked 走独立组件
  if (!isUser && message.blockedData) {
    return <BlockedNotice data={message.blockedData} onSend={onSend} />
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: isUser ? 'row-reverse' : 'row',
      alignItems: 'flex-start',
      gap: 12,
      marginBottom: 16,
      padding: '0 4px',
    }}>
      {isUser ? (
        <Avatar
          size={36}
          style={{
            background: 'linear-gradient(135deg, #1677ff 0%, #3c98ff 100%)',
            flexShrink: 0,
            fontWeight: 700,
          }}
        >我</Avatar>
      ) : (
        <Avatar size={36} src="/chat-avatar.png" style={{ flexShrink: 0 }} />
      )}
      <div style={{
        maxWidth: '82%',
        padding: '12px 16px',
        borderRadius: 16,
        backgroundColor: isUser ? '#1677ff' : '#f7f9fc',
        border: isUser ? 'none' : '1px solid #e7edf7',
        color: isUser ? '#fff' : '#1f2d3d',
        lineHeight: 1.7,
        wordBreak: 'break-word',
        boxShadow: isUser ? '0 10px 22px rgba(22, 119, 255, 0.16)' : '0 10px 22px rgba(26, 55, 109, 0.05)',
      }}>
        {isUser ? (
          <span>{message.content}</span>
        ) : (
          <>
            {/* 置信度标签：🟢 本地标准库 / 🟡 联网搜索 / 🔴 AI 推断 */}
            {message.confidence && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  fontSize: 12,
                  padding: '2px 8px',
                  marginBottom: 8,
                  borderRadius: 10,
                  background:
                    message.confidence.level === 'high'   ? 'rgba(82, 196, 26, 0.10)' :
                    message.confidence.level === 'medium' ? 'rgba(250, 173, 20, 0.12)' :
                                                            'rgba(245, 34, 45, 0.10)',
                  color:
                    message.confidence.level === 'high'   ? '#389e0d' :
                    message.confidence.level === 'medium' ? '#d48806' :
                                                            '#cf1322',
                  border:
                    message.confidence.level === 'high'   ? '1px solid rgba(82, 196, 26, 0.32)' :
                    message.confidence.level === 'medium' ? '1px solid rgba(250, 173, 20, 0.34)' :
                                                            '1px solid rgba(245, 34, 45, 0.32)',
                }}
                title={
                  message.confidence.level === 'high'   ? '基于本地标准元数据库，可信度较高' :
                  message.confidence.level === 'medium' ? '来自联网搜索，请以官方原文为准' :
                                                          'AI 推断 / 辅助生成，请专家审核确认'
                }
              >
                <span>{message.confidence.emoji}</span>
                <span>{message.confidence.label}</span>
              </div>
            )}

            {/* 状态指示器 */}
            {message.statusMessage && !message.content && (
              <StatusIndicator message={message.statusMessage} />
            )}

            {/* 文本内容 */}
            {message.content && (
              <div className="chat-markdown">
                <Markdown allowedElements={[
                  'p', 'br', 'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                  'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'hr', 'table',
                  'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div', 'sup', 'sub',
                ]}>{message.content}</Markdown>
              </div>
            )}

            {/* 联网搜索结果列表 */}
            {message.webSearchResults && message.webSearchResults.items.length > 0 && (
              <div style={{
                marginTop: 12,
                padding: '10px 12px',
                borderRadius: 10,
                background: 'rgba(250, 173, 20, 0.06)',
                border: '1px dashed rgba(250, 173, 20, 0.34)',
                fontSize: 13,
              }}>
                <div style={{ fontSize: 12, color: '#8c6310', marginBottom: 8, fontWeight: 600 }}>
                  🟡 联网搜索来源（{message.webSearchResults.items.length} 条）
                </div>
                <ul style={{ margin: 0, paddingLeft: 18, listStyle: 'decimal' }}>
                  {message.webSearchResults.items.map((s, i) => (
                    <li key={i} style={{ marginBottom: 4, lineHeight: 1.5 }}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer"
                         style={{ color: '#1677ff', textDecoration: 'none' }}>
                        {s.title}
                      </a>
                      {s.site_name && (
                        <span style={{ color: '#8a98ac', marginLeft: 6, fontSize: 12 }}>
                          ({s.site_name})
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* 流式光标 */}
            {message.isStreaming && <span className="streaming-cursor">▍</span>}

            {/* 搜索结果卡片 */}
            {message.searchResults && (
              <SearchResultCard
                items={message.searchResults.items}
              />
            )}

            {/* 任务列表 */}
            {message.taskList && <TaskStatusCard tasks={message.taskList} />}

            {/* CTA 按钮 */}
            {message.actions && message.actions.length > 0 && (
              <ActionButton actions={message.actions} />
            )}

            {/* 建议追问 */}
            {message.suggestions && message.suggestions.length > 0 && (
              <SuggestionChip suggestions={message.suggestions} onSend={onSend} />
            )}

            {/* 大纲确认按钮 */}
            {message.showOutlineActions && (
              <div style={{ marginTop: 12 }}>
                {message.outlineTier === 'free' && (
                  <div style={{ color: '#fa8c16', fontSize: 13, marginBottom: 8 }}>
                    提示：生成标准框架为会员专属功能，确认后将引导您升级。
                  </div>
                )}
                <Space>
                  <Button type="primary" icon={<CheckOutlined />} size="small"
                    onClick={() => onConfirmOutline?.(message.content)}>
                    {message.outlineTier === 'free' ? '确认大纲（需升级会员）' : '确认大纲，生成标准框架'}
                  </Button>
                  <Button icon={<EditOutlined />} size="small" onClick={() => onEditOutline?.(message.content)}>
                    修改大纲
                  </Button>
                </Space>
              </div>
            )}

            {/* 编号核验结果（Phase C-2）— 在框架完成后展示 */}
            {message.verifiedReferences && (message.verifiedReferences.verified.length > 0 || message.verifiedReferences.unverified.length > 0) && (
              <div style={{
                marginTop: 12,
                padding: '10px 12px',
                borderRadius: 10,
                background: 'rgba(120, 120, 120, 0.05)',
                border: '1px dashed rgba(180, 180, 180, 0.5)',
                fontSize: 13,
              }}>
                <div style={{ fontSize: 12, color: '#586474', marginBottom: 6, fontWeight: 600 }}>
                  引用标准核验（共 {message.verifiedReferences.total} 条）
                </div>
                {message.verifiedReferences.verified.length > 0 && (
                  <div style={{ marginBottom: 4 }}>
                    <span style={{ color: '#389e0d', fontWeight: 600 }}>✓ 已核验（{message.verifiedReferences.verified.length}）：</span>
                    <span style={{ color: '#586474' }}>
                      {message.verifiedReferences.verified.map(v => `${v.code}（${v.status}）`).join('；')}
                    </span>
                  </div>
                )}
                {message.verifiedReferences.unverified.length > 0 && (
                  <div>
                    <span style={{ color: '#cf1322', fontWeight: 600 }}>✗ 未在库中检索到（{message.verifiedReferences.unverified.length}）：</span>
                    <span style={{ color: '#586474' }}>
                      {message.verifiedReferences.unverified.map(u => u.code).join('；')}
                    </span>
                    <span style={{ color: '#8a98ac', marginLeft: 4 }}>— 请人工复核</span>
                  </div>
                )}
              </div>
            )}

            {/* 框架下载按钮 */}
            {message.showFrameworkDownload && (
              <div style={{ marginTop: 12 }}>
                <Space>
                  <Button type="link" icon={<FileTextOutlined />}
                    onClick={() => downloadAsMarkdown(message.content)} style={{ padding: '0 4px' }}>
                    Markdown
                  </Button>
                  <Button type="link" icon={<FileTextOutlined />}
                    onClick={() => conversationId && downloadAsWord(conversationId, message.content, message.verifiedReferences)}
                    disabled={!conversationId}
                    style={{ padding: '0 4px' }}>
                    Word (.docx)
                  </Button>
                </Space>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
