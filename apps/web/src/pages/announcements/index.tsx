import { useState, useEffect } from 'react'
import { Card, Typography, Tag, Empty, Spin, Modal, Button } from 'antd'
import { ArrowLeftOutlined, RightOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { getHomeData } from '../../api/app'

const { Title, Text } = Typography

export default function AnnouncementsPage() {
  const nav = useNavigate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [list, setList] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [detail, setDetail] = useState<any>(null)

  useEffect(() => {
    getHomeData()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((res: any) => setList(res?.announcements || []))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  return (
    <div>
      <Button icon={<ArrowLeftOutlined />} type="text" onClick={() => nav(-1)} style={{ marginBottom: 16 }}>
        返回
      </Button>
      <Title level={4} style={{ marginBottom: 16 }}>全部公告</Title>

      {loading && <Spin style={{ display: 'block', margin: '60px auto' }} />}

      {!loading && list.length === 0 && <Empty description="暂无公告" />}

      {!loading && list.length > 0 && (
        <Card styles={{ body: { padding: '4px 0' } }}>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {list.map((a: any, idx: number) => (
            <div
              key={a.id}
              onClick={() => setDetail(a)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '14px 20px', cursor: 'pointer', transition: 'background 0.15s',
                borderBottom: idx < list.length - 1 ? '1px solid #f5f5f5' : 'none',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = '#fafafa')}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <div style={{ flex: 1, overflow: 'hidden' }}>
                <Tag color="blue" style={{ fontSize: 11, marginRight: 8 }}>公告</Tag>
                <Text style={{ fontSize: 14 }}>{a.title}</Text>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{a.date}</Text>
                <RightOutlined style={{ fontSize: 11, color: '#bfbfbf' }} />
              </div>
            </div>
          ))}
        </Card>
      )}

      <Modal
        title={detail?.title}
        open={!!detail}
        onCancel={() => setDetail(null)}
        footer={<Button type="primary" onClick={() => setDetail(null)}>关闭</Button>}
      >
        <div style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>{detail?.date}</div>
        <div style={{ fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>{detail?.content || '暂无详细内容'}</div>
      </Modal>
    </div>
  )
}
