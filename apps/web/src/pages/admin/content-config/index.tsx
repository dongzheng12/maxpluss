import { useState, useEffect, useCallback } from 'react'
import {
  Card,
  Table,
  Button,
  Input,
  Typography,
  message,
  Tag,
  Switch,
  Space,
  Tooltip,
} from 'antd'
import { SaveOutlined, EditOutlined, AppstoreOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../api/client'

const { Title, Text } = Typography

const GROUP_LABELS: Record<string, string> = {
  hero_tags: 'Hero 标签',
  sales_profile: '销售档案默认值',
  home_stats: '首页统计数字',
  home_features: '首页特色卡片',
}

const PLATFORM_COLORS: Record<string, string> = {
  WEB: 'blue',
  MP: 'green',
  BOTH: 'purple',
}

export default function AdminContentConfigPage() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [edits, setEdits] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/content-config')
      setData(res.items || [])
    } catch {
      message.error('加载失败')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load()
  }, [load])

  const handleContentChange = (key: string, val: string) => {
    setEdits((prev) => ({ ...prev, [key]: val }))
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleSave = async (row: any) => {
    const content = edits[row.key] !== undefined ? edits[row.key] : (row.content ?? '')
    setSaving((prev) => ({ ...prev, [row.key]: true }))
    try {
      await nodeApi.put(`/api/admin/content-config/${encodeURIComponent(row.key)}`, { content })
      message.success('已保存')
      // 清除本地编辑状态，刷新
      setEdits((prev) => { const n = { ...prev }; delete n[row.key]; return n })
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '保存失败')
    }
    setSaving((prev) => ({ ...prev, [row.key]: false }))
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleToggleEnabled = async (row: any, enabled: boolean) => {
    try {
      await nodeApi.put(`/api/admin/content-config/${encodeURIComponent(row.key)}`, { enabled })
      message.success(enabled ? '已启用' : '已禁用')
      load()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '操作失败')
    }
  }

  const columns = [
    {
      title: '分组',
      dataIndex: 'group',
      width: 140,
      render: (g: string) => (
        <Tag color="default" style={{ fontSize: 12 }}>
          {GROUP_LABELS[g] || g}
        </Tag>
      ),
    },
    {
      title: '平台',
      dataIndex: 'platform',
      width: 80,
      render: (p: string) => (
        <Tag color={PLATFORM_COLORS[p] || 'default'} style={{ fontSize: 11 }}>
          {p}
        </Tag>
      ),
    },
    {
      title: 'Key',
      dataIndex: 'key',
      width: 200,
      render: (k: string) => <Text code style={{ fontSize: 12 }}>{k}</Text>,
    },
    {
      title: '标题',
      dataIndex: 'title',
      width: 120,
      render: (v: string) => v ? <Text style={{ fontSize: 13 }}>{v}</Text> : <Text type="secondary">-</Text>,
    },
    {
      title: '内容（可编辑）',
      dataIndex: 'content',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (v: string, row: any) => (
        <Input
          value={edits[row.key] !== undefined ? edits[row.key] : (v ?? '')}
          onChange={(e) => handleContentChange(row.key, e.target.value)}
          size="small"
          style={{ minWidth: 200 }}
        />
      ),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 70,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (v: boolean, row: any) => (
        <Switch
          size="small"
          checked={v}
          onChange={(checked) => handleToggleEnabled(row, checked)}
        />
      ),
    },
    {
      title: '操作',
      width: 80,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_: any, row: any) => {
        const dirty = edits[row.key] !== undefined
        return (
          <Tooltip title={dirty ? '保存修改' : '无修改'}>
            <Button
              type={dirty ? 'primary' : 'default'}
              size="small"
              icon={dirty ? <SaveOutlined /> : <EditOutlined />}
              loading={!!saving[row.key]}
              onClick={() => handleSave(row)}
              disabled={!dirty}
            >
              保存
            </Button>
          </Tooltip>
        )
      },
    },
  ]

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <Title level={4} style={{ margin: 0 }}>
          <AppstoreOutlined /> 展示内容管理
        </Title>
        <Space>
          <Button onClick={load}>刷新</Button>
        </Space>
      </div>

      <Card>
        <Table
          scroll={{ x: 'max-content' }}
          rowKey="key"
          columns={columns}
          dataSource={data}
          loading={loading}
          pagination={false}
          locale={{ emptyText: '暂无展示内容配置（请先运行种子脚本）' }}
        />
      </Card>
    </div>
  )
}
