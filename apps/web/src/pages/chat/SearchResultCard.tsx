import { Tag } from 'antd'
import { useNavigate } from 'react-router-dom'
import type { SearchResultItem } from './useChat'

interface Props {
  items: SearchResultItem[]
}

const STATUS_COLOR: Record<string, string> = {
  '现行': 'green', '废止': 'red', '即将实施': 'orange',
}

export default function SearchResultCard({ items }: Props) {
  const nav = useNavigate()

  if (items.length === 0) {
    return null
  }

  return (
    <div style={{ marginTop: 8 }}>
      {items.map((item, i) => (
        <div
          key={i}
          onClick={() => nav(item.detailUrl)}
          style={{
            padding: '8px 12px',
            marginBottom: 6,
            background: '#fafafa',
            borderRadius: 8,
            cursor: 'pointer',
            borderLeft: item.status === '废止' ? '3px solid #ff4d4f' : '3px solid #1677ff',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 600, color: '#1677ff', fontSize: 13 }}>{item.code}</span>
            <Tag color={STATUS_COLOR[item.status] || 'default'} style={{ fontSize: 11, lineHeight: '18px' }}>{item.status}</Tag>
          </div>
          <div style={{ fontSize: 13, color: '#333', marginTop: 2 }}>{item.title}</div>
          <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>
            {item.implDate && `实施：${item.implDate}`}
            {item.committee && ` · ${item.committee}`}
          </div>
          {item.replacedBy && (
            <div style={{ fontSize: 11, color: '#ff4d4f', marginTop: 2 }}>已被 {item.replacedBy} 替代</div>
          )}
        </div>
      ))}
    </div>
  )
}
