import { Button } from 'antd'
import { LinkOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { ActionItem } from './useChat'

interface Props {
  actions: ActionItem[]
}

export default function ActionButton({ actions }: Props) {
  const nav = useNavigate()
  if (!actions || actions.length === 0) return null

  return (
    <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      {actions.map((a, i) => (
        <Button
          key={i}
          type="link"
          size="small"
          icon={a.action === 'external' ? <LinkOutlined /> : undefined}
          onClick={() => {
            if (a.action === 'external') window.open(a.url, '_blank')
            else nav(a.url)
          }}
          style={{ padding: '0 4px' }}
        >
          {a.label}
        </Button>
      ))}
    </div>
  )
}
