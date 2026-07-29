import { useEffect } from 'react'
import { Button } from 'antd'
import { CloseOutlined, AimOutlined } from '@ant-design/icons'
import { findAIAskableFromTarget, type RegisteredAIAskable } from './askableRegistry'

export interface AIPageContentPickerProps {
  active: boolean
  onPick: (entry: RegisteredAIAskable) => void
  onCancel: () => void
}

export function AIPageContentPicker({ active, onPick, onCancel }: AIPageContentPickerProps) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined

    const handleClick = (event: MouseEvent) => {
      const entry = findAIAskableFromTarget(event.target)
      if (!entry) return
      event.preventDefault()
      event.stopPropagation()
      onPick(entry)
      onCancel()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }

    document.addEventListener('click', handleClick, true)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('click', handleClick, true)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [active, onCancel, onPick])

  if (!active) return null

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 28,
        transform: 'translateX(-50%)',
        zIndex: 1201,
        pointerEvents: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px 10px 14px',
        borderRadius: 999,
        color: '#0f172a',
        background: 'rgba(255, 255, 255, 0.96)',
        border: '1px solid rgba(37, 99, 235, 0.25)',
        boxShadow: '0 18px 48px rgba(15, 23, 42, 0.18)',
        fontSize: 13,
      }}
    >
      <AimOutlined style={{ color: '#2563eb' }} />
      <span>选取带小智高亮的页面内容提问，选完自动退出。Esc 取消。</span>
      <Button
        size="small"
        type="text"
        icon={<CloseOutlined />}
        aria-label="退出选取页面内容提问"
        onClick={onCancel}
        style={{ pointerEvents: 'auto' }}
      />
    </div>
  )
}
