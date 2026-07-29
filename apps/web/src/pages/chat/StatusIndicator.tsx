import { Spin } from 'antd'

interface Props {
  message: string
}

export default function StatusIndicator({ message }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', color: '#999', fontSize: 13 }}>
      <Spin size="small" />
      <span>{message}</span>
    </div>
  )
}
