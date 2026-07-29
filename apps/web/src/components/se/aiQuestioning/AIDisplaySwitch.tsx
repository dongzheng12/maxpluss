import { Space, Switch, Typography } from 'antd'
import { RobotOutlined } from '@ant-design/icons'
import { useAIDisplayPreference } from './displayPreference'

const { Text } = Typography

export interface AIDisplaySwitchProps {
  compact?: boolean
  disabled?: boolean
  label?: string
}

export function AIDisplaySwitch({ compact = false, disabled = false, label = 'AI 显示' }: AIDisplaySwitchProps) {
  const { enabled, setEnabled } = useAIDisplayPreference()

  return (
    <Space size={compact ? 6 : 8} align="center" title="控制问小智浮标和页面 hover 图标显隐">
      {!compact && <RobotOutlined style={{ color: enabled ? '#2563eb' : '#94a3b8' }} />}
      {!compact && <Text type="secondary" style={{ fontSize: 12 }}>{label}</Text>}
      <Switch
        size="small"
        checked={enabled}
        disabled={disabled}
        checkedChildren="开"
        unCheckedChildren="关"
        onChange={setEnabled}
        aria-label={label}
      />
    </Space>
  )
}
