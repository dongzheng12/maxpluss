/**
 * R03 站内弹窗 — 比对报告摘要页会员升级引导
 *
 * 触发条件：免费用户 + compare_complete + isLibrary + !fullReportUnlocked
 * 文案来源：营销自动化方案-最终版-全量话术优化版 R03
 * 关闭：本次会话（sessionStorage）内按 taskNo 级别不再弹
 */
import { useState, useEffect } from 'react'
import { Button, Space, Typography } from 'antd'
import { CloseOutlined, CrownOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'

const { Text } = Typography

const DISMISS_KEY_PREFIX = 'r03_dismissed_'

interface Props {
  /** 用于区分不同报告的关闭状态 */
  taskNo: string
}

export default function CompareUpgradePrompt({ taskNo }: Props) {
  const nav = useNavigate()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const dismissed = sessionStorage.getItem(DISMISS_KEY_PREFIX + taskNo)
    if (!dismissed) {
      // 延迟 1.2s 弹，避免与页面主体渲染抢视觉焦点
      const t = setTimeout(() => setVisible(true), 1200)
      return () => clearTimeout(t)
    }
  }, [taskNo])

  const handleClose = () => {
    sessionStorage.setItem(DISMISS_KEY_PREFIX + taskNo, '1')
    setVisible(false)
  }

  const handleUpgrade = () => {
    sessionStorage.setItem(DISMISS_KEY_PREFIX + taskNo, '1')
    setVisible(false)
    nav('/membership')
  }

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        left: 16,
        right: 16,
        bottom: 16,
        maxWidth: 720,
        margin: '0 auto',
        background: '#fff',
        boxShadow: '0 6px 24px rgba(0,0,0,0.12), 0 3px 8px rgba(0,0,0,0.06)',
        border: '1px solid #f0f0f0',
        borderRadius: 12,
        padding: '14px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        zIndex: 999,
      }}
      role="dialog"
      aria-label="会员升级引导"
    >
      <CrownOutlined style={{ fontSize: 24, color: '#faad14', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <Text style={{ fontSize: 14, lineHeight: 1.6, display: 'block' }}>
          当前页面为摘要展示，会员可继续查看完整分析内容、更多结果详情及后续使用权益
        </Text>
      </div>
      <Space size={8} style={{ flexShrink: 0 }}>
        <Button type="primary" icon={<CrownOutlined />} onClick={handleUpgrade}>
          查看会员权益
        </Button>
        <Button type="text" icon={<CloseOutlined />} onClick={handleClose} aria-label="关闭" />
      </Space>
    </div>
  )
}
