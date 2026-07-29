/**
 * 销售推广素材中心
 * 调 GET /api/app/sales/materials 拉取后端预设的 3 段文案，
 * 用 navigator.clipboard 一键复制。
 */
import { useEffect, useState } from 'react'
import { Card, Typography, Button, Space, message, Spin, Alert } from 'antd'
import { CopyOutlined, MessageOutlined, AppstoreOutlined, GiftOutlined } from '@ant-design/icons'
import { nodeApi } from '../../api/client'

const { Title, Text } = Typography

interface Materials {
  wechatGroup: string
  moments: string
  intro: string
}

const COPY_TIPS: Record<keyof Materials, { title: string; icon: React.ReactNode; tip: string }> = {
  wechatGroup: { title: '微信群文案', icon: <MessageOutlined />, tip: '一键复制后粘贴到微信群，含你的专属归因链接' },
  moments: { title: '朋友圈文案', icon: <AppstoreOutlined />, tip: '适合朋友圈日常推广，emoji 友好排版' },
  intro: { title: '产品介绍文案', icon: <GiftOutlined />, tip: '完整四产品矩阵介绍，适合一对一私聊或长文推送' },
}

export default function SalesMaterialPage() {
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState<Materials | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    nodeApi.get('/api/app/sales/materials')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((res: any) => setData(res))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .catch((e: any) => setError(e?.response?.data?.error || '加载失败'))
      .finally(() => setLoading(false))
  }, [])

  const copy = async (key: keyof Materials, content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      message.success(`已复制「${COPY_TIPS[key].title}」到剪贴板`)
    } catch {
      message.error('复制失败，请手动选中文本复制')
    }
  }

  if (loading) return <div style={{ padding: 48, textAlign: 'center' }}><Spin size="large" /></div>
  if (error || !data) {
    return (
      <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
        <Alert type="error" message={error || '加载失败'} showIcon />
      </div>
    )
  }

  return (
    <div style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 20 }}>
        <Title level={3} style={{ margin: 0 }}>推广素材</Title>
        <Text type="secondary">三套预制文案，含你的专属归因链接，一键复制即用</Text>
      </div>

      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {(['wechatGroup', 'moments', 'intro'] as const).map((key) => {
          const meta = COPY_TIPS[key]
          const content = data[key]
          return (
            <Card
              key={key}
              title={<Space>{meta.icon} {meta.title}</Space>}
              extra={
                <Button
                  type="primary"
                  icon={<CopyOutlined />}
                  onClick={() => copy(key, content)}
                >
                  一键复制
                </Button>
              }
            >
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                {meta.tip}
              </Text>
              <pre style={{
                background: '#f5f7fa',
                padding: 16,
                borderRadius: 8,
                fontSize: 13,
                lineHeight: 1.7,
                fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: 0,
                maxHeight: 400,
                overflow: 'auto',
              }}>{content}</pre>
            </Card>
          )
        })}
      </Space>
    </div>
  )
}
