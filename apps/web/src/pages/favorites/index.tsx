import { useState, useEffect } from 'react'
import { Card, Typography, Tag, Empty, Button, Space, List, message } from 'antd'
import { StarFilled, DeleteOutlined, ArrowLeftOutlined, SearchOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { pyApi } from '../../api/client'

const { Title, Text } = Typography

const FAVORITES_KEY = 'bxz_favorites'

function getFavorites(): string[] {
  try { return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]') } catch { return [] }
}

const statusColors: Record<string, string> = {
  '现行': 'green', '即将实施': 'blue', '废止': 'red', '被代替': 'orange',
}

export default function FavoritesPage() {
  const nav = useNavigate()
  const [codes, setCodes] = useState<string[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [details, setDetails] = useState<Record<string, any>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const favs = getFavorites()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCodes(favs)
    if (favs.length === 0) { setLoading(false); return }

    // Batch fetch details for all favorited standards
    setLoading(true)
    Promise.all(
      favs.map((code) =>
        pyApi.get('/api/v1/standard-detail', { params: { code } })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .then((res: any) => ({ code, data: res }))
          .catch(() => ({ code, data: null }))
      )
    ).then((results) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map: Record<string, any> = {}
      results.forEach((r) => { if (r.data) map[r.code] = r.data })
      setDetails(map)
    }).finally(() => setLoading(false))
  }, [])

  const removeFavorite = (code: string) => {
    const favs = getFavorites().filter((c) => c !== code)
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs))
    setCodes(favs)
    message.success('已取消收藏')
  }

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} type="text" onClick={() => nav(-1)}>返回</Button>
        <Title level={4} style={{ margin: 0 }}>
          <StarFilled style={{ color: '#faad14', marginRight: 8 }} />
          我的收藏
        </Title>
        <Text type="secondary">({codes.length} 条)</Text>
      </Space>

      {codes.length === 0 && !loading ? (
        <Card>
          <Empty
            description="还没有收藏任何标准"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          >
            <Button type="primary" icon={<SearchOutlined />} onClick={() => nav('/standards')}>
              去搜索标准
            </Button>
          </Empty>
        </Card>
      ) : (
        <List
          loading={loading}
          dataSource={codes}
          renderItem={(code) => {
            const detail = details[code]
            return (
              <Card
                hoverable
                style={{ marginBottom: 12, borderRadius: 10, cursor: 'pointer' }}
                styles={{ body: { padding: '16px 20px' } }}
                onClick={() => nav(`/standards/${encodeURIComponent(code)}`)}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1 }}>
                    <Space size="small" style={{ marginBottom: 6 }}>
                      <Text strong style={{ fontSize: 15 }}>{code}</Text>
                      {detail?.status && (
                        <Tag color={statusColors[detail.status] || 'default'} style={{ fontSize: 11 }}>
                          {detail.status}
                        </Tag>
                      )}
                      {detail?.is_mandatory && <Tag color="red" style={{ fontSize: 11 }}>强制性</Tag>}
                    </Space>
                    <div>
                      <Text type="secondary" style={{ fontSize: 13 }}>
                        {detail?.name || '加载中...'}
                      </Text>
                    </div>
                    {detail?.pub_date && (
                      <Text type="secondary" style={{ fontSize: 12, marginTop: 4, display: 'block' }}>
                        发布日期：{detail.pub_date}
                      </Text>
                    )}
                  </div>
                  <Button
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={(e) => { e.stopPropagation(); removeFavorite(code) }}
                    style={{ flexShrink: 0 }}
                  >
                    取消收藏
                  </Button>
                </div>
              </Card>
            )
          }}
        />
      )}
    </div>
  )
}
