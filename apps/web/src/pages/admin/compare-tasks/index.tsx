import { useState, useEffect } from 'react'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { Table, Card, Tag, Typography, Button, Space, Tooltip, message } from 'antd'
import { ReloadOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import { nodeApi } from '../../../api/client'

const { Title } = Typography


export default function AdminCompareTasksPage() {
  const isMobile = useIsMobile()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(false)

  const showFailureReason = (reason?: string) => {
    if (!reason) return
    message.info({
      content: <div style={{ maxWidth: 360, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{reason}</div>,
      duration: 6,
    })
  }

  const renderStatusTag = (status: string, reason?: string) => {
    const hasReason = status === 'FAILED' && !!reason
    return (
      <Space size={4}>
        <Tag color={status === 'COMPLETED' ? 'green' : status === 'FAILED' ? 'red' : 'blue'} style={{ marginInlineEnd: 0 }}>
          {status === 'COMPLETED' ? '已完成' : status === 'FAILED' ? '失败' : '处理中'}
        </Tag>
        {hasReason && (
          <Tooltip
            title={<div style={{ maxWidth: 360, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{reason}</div>}
            placement="topLeft"
          >
            <span
              role="button"
              tabIndex={0}
              aria-label="查看失败原因"
              onClick={(e) => {
                e.stopPropagation()
                showFailureReason(reason)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  showFailureReason(reason)
                }
              }}
              style={{ color: '#ff4d4f', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
            >
              <QuestionCircleOutlined />
            </span>
          </Tooltip>
        )}
      </Space>
    )
  }

  const load = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await nodeApi.get('/api/admin/compare-tasks')
      setItems(res?.items || [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [])

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <Title level={4} style={{ margin: 0 }}>比对任务管理</Title>
        <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
      </Space>

      <Card>
        <Table scroll={{ x: "max-content" }}
          rowKey="taskNo"
          dataSource={items}
          loading={loading}
          columns={[
            { title: '任务号', dataIndex: 'taskNo', width: 180, hidden: isMobile },
            { title: '用户手机号', dataIndex: ['user', 'phone'], width: 130, hidden: isMobile },
            { title: '用户姓名', dataIndex: ['user', 'name'], width: 100 },
            { title: '文档名', dataIndex: 'documentName', ellipsis: true },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { title: '状态', dataIndex: 'status', width: 120, render: (s: string, record: any) => renderStatusTag(s, record.errorMessage) },
            {
              title: '创建时间', dataIndex: 'createdAt', width: 180, hidden: isMobile,
              render: (v: string) => v ? new Date(v).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-',
            },
          ].filter(c => !('hidden' in c && c.hidden))}
        />
      </Card>
    </div>
  )
}
