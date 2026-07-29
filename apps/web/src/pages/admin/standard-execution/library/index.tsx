import { Button, Typography } from 'antd'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeftOutlined } from '@ant-design/icons'
import SeSourcesPage from '../sources'
import SeRequirementsPage from '../requirements'

const { Title, Text } = Typography

export default function SeStandardLibraryPage() {
  const loc = useLocation()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const isEnterprise = loc.pathname.startsWith('/enterprise')
  const basePath = isEnterprise ? '/enterprise/sources' : '/admin/standard-execution/sources'
  const showAdvancedRequirements = params.get('advanced') === 'requirements'

  if (showAdvancedRequirements && isEnterprise) return <SeSourcesPage />

  if (showAdvancedRequirements) {
    return (
      <div>
        <div style={{ marginBottom: 16 }}>
          <Button icon={<ArrowLeftOutlined />} onClick={() => nav(basePath)} style={{ marginBottom: 12 }}>
            返回标准来源
          </Button>
          <Title level={3} style={{ margin: 0 }}>解析结果</Title>
          <Text type="secondary">高级视图：查看标准来源解析出的来源条款，用于排查解析结果并生成任务草稿。</Text>
        </div>
        <SeRequirementsPage />
      </div>
    )
  }

  if (isEnterprise) return <SeSourcesPage />

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>标准库</Title>
        <Text type="secondary">上传、整理和维护标准来源，并从来源生成任务草稿。</Text>
      </div>
      <SeSourcesPage />
    </div>
  )
}
