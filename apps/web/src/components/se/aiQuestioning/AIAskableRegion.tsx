import { useContext, useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Tooltip } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import { SEPageContext } from '../../../contexts/SEPageContext'
import { registerAIAskable } from './askableRegistry'
import { buildAIAskPayload, DEFAULT_AI_CONTEXT_QUESTION, type AIQuestionContext } from './types'
import { useAIDisplayPreference } from './displayPreference'

export interface AIAskableRegionProps {
  context: AIQuestionContext
  children: ReactNode
  question?: string
  disabled?: boolean
  className?: string
  style?: CSSProperties
  iconLabel?: string
  onAsk?: (context: AIQuestionContext) => void
}

const baseStyle: CSSProperties = {
  position: 'relative',
  borderRadius: 10,
  transition: 'box-shadow 160ms ease, outline-color 160ms ease, background 160ms ease',
}

export function AIAskableRegion({
  context,
  children,
  question = DEFAULT_AI_CONTEXT_QUESTION,
  disabled = false,
  className,
  style,
  iconLabel = '问小智',
  onAsk,
}: AIAskableRegionProps) {
  const askableId = useId()
  const [hovered, setHovered] = useState(false)
  const { triggerAsk } = useContext(SEPageContext)
  const { enabled } = useAIDisplayPreference()
  const active = enabled && !disabled
  const payload = useMemo(() => buildAIAskPayload(context, question), [context, question])

  useEffect(() => {
    if (!active) return undefined
    return registerAIAskable(askableId, { context, question })
  }, [active, askableId, context, question])

  const ask = (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    triggerAsk(payload.contextText, payload.question)
    onAsk?.(context)
  }

  return (
    <div
      className={className}
      data-ai-askable-id={active ? askableId : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setHovered(true)}
      onBlurCapture={() => setHovered(false)}
      style={{
        ...baseStyle,
        ...style,
        outline: active && hovered ? '1px solid rgba(37, 99, 235, 0.35)' : '1px solid transparent',
        boxShadow: active && hovered ? '0 10px 28px rgba(37, 99, 235, 0.12)' : style?.boxShadow,
        background: active && hovered ? 'linear-gradient(180deg, rgba(239, 246, 255, 0.34), rgba(255, 255, 255, 0))' : style?.background,
      }}
    >
      {children}
      {active && hovered && (
        <Tooltip title={iconLabel}>
          <Button
            type="primary"
            shape="circle"
            size="small"
            aria-label={iconLabel}
            icon={<RobotOutlined />}
            onClick={ask}
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              zIndex: 2,
              background: 'linear-gradient(135deg, #2563eb 0%, #0f766e 100%)',
              border: 'none',
              boxShadow: '0 8px 18px rgba(37, 99, 235, 0.25)',
            }}
          />
        </Tooltip>
      )}
    </div>
  )
}
