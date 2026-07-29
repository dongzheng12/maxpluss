import { Typography, Table, Tag, Button, Card } from 'antd'
import { useEffect, useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  CloseCircleFilled, LockOutlined,
  CrownOutlined, ArrowLeftOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { getAppConfig } from '../../api/app'
import { fallbackBenefitsMatrix, type MembershipBenefitsColumnKey, type MembershipBenefitsMatrix, resolveBenefitsMatrix } from './benefitsMatrix'

const { Title, Text, Paragraph } = Typography

const no = <CloseCircleFilled style={{ color: '#d9d9d9', fontSize: 16 }} />
const lock = <LockOutlined style={{ color: '#ff4d4f', fontSize: 14 }} />

function Limit({ text }: { text: string }) {
  return <Tag color="blue" style={{ margin: 0 }}>{text}</Tag>
}
function Unlimited() {
  return <Tag color="green" style={{ margin: 0 }}>不限次</Tag>
}

function renderBenefitValue(value: string, columnKey: MembershipBenefitsColumnKey) {
  if (value === '不限次') return <Unlimited />
  if (value === '不可用') return columnKey === 'guest' ? lock : no
  return <Limit text={value} />
}


export default function BenefitsPage() {
  const nav = useNavigate()
  const isMobile = useIsMobile()
  const [matrix, setMatrix] = useState<MembershipBenefitsMatrix>(fallbackBenefitsMatrix)

  useEffect(() => {
    let cancelled = false
    getAppConfig()
      .then((config) => {
        if (!cancelled) {
          setMatrix(resolveBenefitsMatrix(config?.membershipBenefitsMatrix))
        }
      })
      .catch(() => {
        if (!cancelled) setMatrix(fallbackBenefitsMatrix)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const columns = [
    {
      title: '',
      dataIndex: 'feature',
      key: 'feature',
      width: isMobile ? 120 : 200,
      render: (v: string) => <Text strong style={{ fontSize: 13.5 }}>{v}</Text>,
    },
    ...matrix.columns.map((column) => ({
      title: column.key === 'personal'
        ? <span style={{ color: '#1677ff' }}>{column.label}</span>
        : column.key === 'pro'
          ? <span style={{ color: '#faad14' }}>{column.label}</span>
          : column.key === 'guest'
            ? <span style={{ color: '#8c8c8c' }}>{column.label}</span>
            : column.label,
      dataIndex: column.key,
      key: column.key,
      width: column.key === 'guest' ? 90 : 140,
      align: 'center' as const,
      hidden: isMobile && (column.key === 'guest' || column.key === 'free'),
      render: (value: string) => renderBenefitValue(value, column.key),
    })),
  ].filter(c => !('hidden' in c && c.hidden))

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => nav('/membership')}>
          返回会员计划
        </Button>
      </div>

      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <Title level={3} style={{ marginBottom: 8 }}>
          <CrownOutlined style={{ color: '#faad14', marginRight: 8 }} />
          会员权益对照
        </Title>
        <Paragraph type="secondary" style={{ fontSize: 14 }}>
          各功能在不同会员等级下的使用权限一览
        </Paragraph>
      </div>

      {matrix.sections.map((section) => (
        <Card
          key={section.key}
          style={{ marginBottom: 20, borderRadius: 12 }}
          styles={{ body: { padding: 0 } }}
        >
          <div style={{ padding: '16px 24px 0', textAlign: 'left' }}>
            <Title level={5} style={{ margin: 0, textAlign: 'left' }}>{section.title}</Title>
          </div>
          <Table
            dataSource={section.rows.map((row) => ({
              key: row.key,
              feature: row.name,
              ...row.values,
            }))}
            columns={columns}
            pagination={false}
            size="middle"
            style={{ marginTop: 8 }}
          />
        </Card>
      ))}

      <Card style={{ borderRadius: 12, marginBottom: 40, background: '#fafafa' }}>
        <Title level={5}>说明</Title>
        <ul style={{ paddingLeft: 20, margin: 0, lineHeight: 2, color: '#595959', fontSize: 13.5 }}>
          {matrix.noteItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </Card>

      <div style={{ textAlign: 'center', marginBottom: 40 }}>
        <Button type="primary" size="large" onClick={() => nav('/membership')} style={{ borderRadius: 8, height: 44, width: 200 }}>
          选择会员计划
        </Button>
      </div>
    </div>
  )
}
