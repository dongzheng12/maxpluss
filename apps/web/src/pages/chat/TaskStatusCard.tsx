import { Tag, Button } from 'antd'
import { useNavigate } from 'react-router-dom'
import type { TaskItem } from './useChat'

interface Props {
  tasks: TaskItem[]
}

const STATUS_MAP: Record<string, { color: string; label: string }> = {
  PENDING: { color: 'blue', label: '排队中' },
  PROCESSING: { color: 'orange', label: '处理中' },
  COMPLETED: { color: 'green', label: '已完成' },
  FAILED: { color: 'red', label: '处理失败' },
}

export default function TaskStatusCard({ tasks }: Props) {
  const nav = useNavigate()

  if (tasks.length === 0) {
    return (
      <div style={{ marginTop: 8 }}>
        <div style={{ color: '#999', fontSize: 13 }}>暂无比对任务</div>
        <Button type="link" size="small" onClick={() => nav('/compare')} style={{ padding: '0 4px', marginTop: 4 }}>
          前往比对页面
        </Button>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 8 }}>
      {tasks.map((t, i) => {
        const st = STATUS_MAP[t.status] || { color: 'default', label: t.status }
        return (
          <div key={i} style={{
            padding: '8px 12px',
            marginBottom: 6,
            background: '#fafafa',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.documentName}
              </div>
              <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
                {t.taskNo} · {new Date(t.createdAt).toLocaleString('zh-CN')}
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <Tag color={st.color} style={{ fontSize: 11, margin: 0 }}>{st.label}</Tag>
              {t.status === 'COMPLETED' && t.reportUrl && (
                <Button type="link" size="small" onClick={() => nav(t.reportUrl!)} style={{ padding: 0, fontSize: 12 }}>
                  查看报告
                </Button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
