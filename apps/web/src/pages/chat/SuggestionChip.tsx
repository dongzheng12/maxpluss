import { Tag } from 'antd'
import type { SuggestionItem } from './useChat'

interface Props {
  suggestions: SuggestionItem[]
  onSend: (text: string) => void
}

export default function SuggestionChip({ suggestions, onSend }: Props) {
  if (!suggestions || suggestions.length === 0) return null

  return (
    <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {suggestions.map((s, i) => (
        <Tag
          key={i}
          color="blue"
          onClick={() => onSend(s.text)}
          style={{ cursor: 'pointer', borderRadius: 12, fontSize: 12 }}
        >
          {s.label}
        </Tag>
      ))}
    </div>
  )
}
