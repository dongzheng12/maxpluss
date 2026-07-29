import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Input, Button, Tooltip } from 'antd'
import { SendOutlined } from '@ant-design/icons'

const MAX_MESSAGE_LENGTH = 2000

interface Props {
  onSend: (msg: string) => void
  disabled?: boolean
  placeholder?: string
  value?: string
  onChange?: (value: string) => void
  autoFocusTrigger?: number
}

export default function ChatInput({ onSend, disabled, placeholder, value: controlledValue, onChange, autoFocusTrigger }: Props) {
  const [innerValue, setInnerValue] = useState('')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const textareaRef = useRef<any>(null)
  const isControlled = controlledValue !== undefined
  const value = isControlled ? controlledValue : innerValue

  const setValue = (nextValue: string) => {
    if (!isControlled) {
      setInnerValue(nextValue)
    }
    onChange?.(nextValue)
  }

  useEffect(() => {
    if (autoFocusTrigger === undefined) return
    textareaRef.current?.focus?.()
  }, [autoFocusTrigger])

  const handleSend = () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    if (trimmed.length > MAX_MESSAGE_LENGTH) return  // 超长由 Tooltip 提示，不发送
    onSend(trimmed)
    setValue('')
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const trimmed = value.trim()
  const tooLong = trimmed.length > MAX_MESSAGE_LENGTH
  const remaining = MAX_MESSAGE_LENGTH - trimmed.length

  return (
    <div style={{
      display: 'flex',
      gap: 8,
      padding: '14px 0 18px',
      alignItems: 'flex-end',
    }}>
      <div style={{ flex: 1, position: 'relative' }}>
        <Input.TextArea
          ref={textareaRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || '输入消息，按 Enter 发送...'}
          disabled={disabled}
          autoSize={{ minRows: 2, maxRows: 6 }}
          status={tooLong ? 'error' : undefined}
          style={{
            borderRadius: 16,
            padding: '8px 12px',
            boxShadow: '0 8px 24px rgba(25, 55, 120, 0.06)',
          }}
        />
        {trimmed.length > MAX_MESSAGE_LENGTH - 200 && (
          <div style={{
            position: 'absolute', bottom: 6, right: 10,
            fontSize: 11, color: tooLong ? '#ff4d4f' : '#999',
            pointerEvents: 'none', userSelect: 'none',
          }}>
            {tooLong ? `超出 ${-remaining} 字` : `还可输入 ${remaining} 字`}
          </div>
        )}
      </div>
      <Tooltip title={tooLong ? `消息不能超过 ${MAX_MESSAGE_LENGTH} 字，请精简内容` : undefined}>
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={handleSend}
          disabled={disabled || !trimmed || tooLong}
          style={{ borderRadius: 14, height: 44, minWidth: 52, boxShadow: '0 10px 20px rgba(22, 119, 255, 0.18)' }}
        />
      </Tooltip>
    </div>
  )
}
