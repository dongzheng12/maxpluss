import { useState, useEffect } from 'react'
import { useIsMobile } from '../../../hooks/useIsMobile'
import { Table, Card, Typography, Button, Input, Tag, Statistic, Row, Col } from 'antd'
import { ReloadOutlined, DatabaseOutlined } from '@ant-design/icons'
import { adminListStandards } from '../../../api/admin'
import { searchStandards } from '../../../api/standards'

const { Title, Text } = Typography
const { Search } = Input


export default function AdminStandardsPage() {
  const isMobile = useIsMobile()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [nodeItems, setNodeItems] = useState<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [pySearch, setPySearch] = useState<any>(null)
  const [pyQuery, setPyQuery] = useState('')
  const [pyPage, setPyPage] = useState(1)
  const [loading, setLoading] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)

  const loadNode = async () => {
    setLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await adminListStandards()
      setNodeItems(Array.isArray(res) ? res : [])
    } catch { /* ignore */ }
    setLoading(false)
  }

  const doPySearch = async (q: string, page = 1) => {
    if (!q) return
    setSearchLoading(true)
    setPyQuery(q)
    setPyPage(page)
    try {
      const res = await searchStandards({ q, page, page_size: 20 })
      setPySearch(res)
    } catch { /* ignore */ }
    setSearchLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { loadNode() }, [])

  return (
    <div>
      <Title level={4}>标准库管理</Title>

      {/* Python Knowledge Engine stats */}
      <Row gutter={16} style={{ marginBottom: 24 }}>
        <Col span={8}>
          <Card>
            <Statistic title="Python知识引擎" value="已接入" prefix={<DatabaseOutlined />} suffix="知识库" />
            <Text type="secondary">标准知识引擎（外部）</Text>
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="本地SQLite" value="73,100" prefix={<DatabaseOutlined />} suffix="条记录" />
            <Text type="secondary">本地标准库</Text>
          </Card>
        </Col>
        <Col span={8}>
          <Card>
            <Statistic title="Node.js 种子数据" value={nodeItems.length} prefix={<DatabaseOutlined />} suffix="条" />
            <Text type="secondary">Prisma Standard 表</Text>
          </Card>
        </Col>
      </Row>

      {/* Quick search from Python API */}
      <Card title="知识库检索" style={{ marginBottom: 24 }}>
        <Search
          placeholder="输入关键词搜索标准..."
          enterButton="搜索"
          onSearch={(v) => doPySearch(v)}
          loading={searchLoading}
          style={{ maxWidth: 500, marginBottom: 16 }}
        />
        {pySearch && (
          <>
            <Text>命中 <Text strong>{pySearch.total?.toLocaleString()}</Text> 条结果</Text>
            <Table scroll={{ x: "max-content" }}
              rowKey="code"
              dataSource={pySearch.items || []}
              size="small"
              style={{ marginTop: 8 }}
              pagination={{
                current: pyPage,
                pageSize: 20,
                total: pySearch.total || 0,
                showSizeChanger: false,
                showTotal: (total) => `共 ${total.toLocaleString()} 条`,
                onChange: (page) => doPySearch(pyQuery, page),
              }}
              columns={[
                { title: '编号', dataIndex: 'code', width: isMobile ? 120 : 180 },
                { title: '名称', dataIndex: 'name', ellipsis: true },
                { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => <Tag>{s}</Tag> },
              ]}
            />
          </>
        )}
      </Card>

      {/* Node.js managed standards */}
      <Card title="Node.js 标准管理" extra={<Button icon={<ReloadOutlined />} onClick={loadNode}>刷新</Button>}>
        <Table scroll={{ x: "max-content" }}
          rowKey="id"
          dataSource={nodeItems}
          loading={loading}
          columns={[
            { title: 'ID', dataIndex: 'id', width: 60, hidden: isMobile },
            { title: '标题', dataIndex: 'title', ellipsis: true },
            { title: '级别', dataIndex: 'level', width: 80, hidden: isMobile },
            { title: '来源', dataIndex: 'source', width: 80, hidden: isMobile },
            { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => <Tag>{s}</Tag> },
            { title: '版本', dataIndex: 'version', width: 80, hidden: isMobile },
          ].filter(c => !('hidden' in c && c.hidden))}
        />
      </Card>
    </div>
  )
}
