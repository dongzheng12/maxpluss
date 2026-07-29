import { Avatar } from 'antd'
import { WarningOutlined } from '@ant-design/icons'
import type { BlockedData } from './useChat'

interface Props {
  data: BlockedData
  onSend: (text: string) => void
}

export default function BlockedNotice({ data, onSend }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16, padding: '0 4px' }}>
      <Avatar size={36} src="/chat-avatar.png" style={{ flexShrink: 0 }} />
      <div style={{
        maxWidth: '75%',
        padding: '12px 16px',
        borderRadius: 12,
        backgroundColor: '#fff7e6',
        border: '1px solid #ffd591',
        lineHeight: 1.6,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontWeight: 600, color: '#d46b08' }}>
          <WarningOutlined /> 版权提示
        </div>
        <div style={{ fontSize: 13, color: '#333', whiteSpace: 'pre-line' }}>{data.content}</div>
        {data.officialLinks.length > 0 && (
          <ul style={{ margin: '8px 0', paddingLeft: 20, fontSize: 13 }}>
            {data.officialLinks.map((link, i) => (
              <li key={i}>
                <a href={link.url} target="_blank" rel="noopener noreferrer" style={{ color: '#1677ff' }}>
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        )}
        {data.suggestions.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {data.suggestions.map((s, i) => (
              <span
                key={i}
                onClick={() => onSend(s)}
                style={{
                  cursor: 'pointer',
                  padding: '2px 10px',
                  borderRadius: 12,
                  background: '#e6f4ff',
                  color: '#1677ff',
                  fontSize: 12,
                  border: '1px solid #91caff',
                }}
              >
                {s}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
