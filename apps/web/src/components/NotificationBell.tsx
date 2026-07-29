/**
 * 站内通知铃铛 — PC Web 右上角
 *
 * 数据源：GET /api/app/notifications（营销自动化任务五后端）
 * 轮询：挂载时 + 每 60s 刷一次，仅用户登录时轮询
 *
 * 交互：
 *  - 未读 > 0 显示红点 + 数字徽标
 *  - 点击铃铛 → Popover 列表（20 条最新）
 *  - 单条点击 → 调 /:id/read 后跳 link
 *  - 列表底部「全部已读」一键清红点
 */
import { useCallback, useEffect, useState } from 'react'
import { Badge, Button, Popover, List, Typography, Space, Empty, Spin } from 'antd'
import { BellOutlined, CheckCircleOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import {
  getNotifications,
  readNotification,
  readAllNotifications,
  type NotificationItem,
} from '../api/app'

const { Text } = Typography
const POLL_INTERVAL_MS = 60_000

/**
 * 将通知 link 字段（小程序路径格式）映射为 PC Web router 路径。
 * 若无法识别则原样返回，让 react-router 处理 404。
 */
function resolveLink(link: string): string {
  // /pages/expert-vote/meeting/index?no=XXX  →  /expert-vote/XXX/meeting
  const meetingMatch = link.match(/^\/pages\/expert-vote\/meeting\/index\?no=(.+)/)
  if (meetingMatch) return `/expert-vote/${meetingMatch[1]}/meeting`

  // /pages/expert-vote/detail/index?no=XXX  →  /expert-vote/XXX
  const detailMatch = link.match(/^\/pages\/expert-vote\/detail\/index\?no=(.+)/)
  if (detailMatch) return `/expert-vote/${detailMatch[1]}`

  // fallback：已经是 web 路径（如 /expert-vote/...）直接使用
  return link
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

export default function NotificationBell() {
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<NotificationItem[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setLoading(true)
      const data = await getNotifications(1, 20)
      setItems(data.items)
      setUnread(data.unreadCount)
    } catch {
      // 静默：未登录 / 网络异常不在铃铛展示错误
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refresh])

  const handleItemClick = async (item: NotificationItem) => {
    if (!item.readAt) {
      try { await readNotification(item.id) } catch { /* 静默 */ }
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)))
      setUnread((n) => Math.max(0, n - 1))
    }
    setOpen(false)
    if (item.link) nav(resolveLink(item.link))
  }

  const handleReadAll = async () => {
    if (unread === 0) return
    try {
      await readAllNotifications()
      const now = new Date().toISOString()
      setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })))
      setUnread(0)
    } catch { /* 静默 */ }
  }

  const content = (
    <div style={{ width: 360, maxHeight: 480, overflow: 'auto' }}>
      {loading && items.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 32 }}><Spin /></div>
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消息" style={{ padding: 24 }} />
      ) : (
        <List
          dataSource={items}
          renderItem={(item) => (
            <List.Item
              style={{
                padding: '12px 16px',
                cursor: 'pointer',
                background: item.readAt ? '#fff' : '#f6fbff',
                borderLeft: item.readAt ? '3px solid transparent' : '3px solid #1677ff',
              }}
              onClick={() => handleItemClick(item)}
            >
              <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <Text strong={!item.readAt} style={{ fontSize: 14 }}>{item.title}</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>{timeAgo(item.createdAt)}</Text>
                </div>
                <Text type="secondary" style={{ fontSize: 13, display: 'block', lineHeight: 1.5 }}>
                  {item.body}
                </Text>
              </div>
            </List.Item>
          )}
        />
      )}
      {items.length > 0 && (
        <div style={{ padding: '8px 16px', borderTop: '1px solid #f0f0f0', textAlign: 'right', background: '#fafafa' }}>
          <Space>
            <Button type="link" size="small" icon={<CheckCircleOutlined />} onClick={handleReadAll} disabled={unread === 0}>
              全部已读
            </Button>
          </Space>
        </div>
      )}
    </div>
  )

  return (
    <Popover
      content={content}
      trigger="click"
      open={open}
      onOpenChange={(v) => { setOpen(v); if (v) refresh() }}
      placement="bottomRight"
      overlayInnerStyle={{ padding: 0 }}
    >
      <Badge count={unread} overflowCount={99} offset={[-4, 4]}>
        <Button type="text" icon={<BellOutlined style={{ fontSize: 18 }} />} />
      </Badge>
    </Popover>
  )
}
