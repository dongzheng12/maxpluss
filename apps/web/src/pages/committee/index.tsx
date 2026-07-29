import { useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Card, Table, Input, Select, Typography, Space, Button } from 'antd'
import { SearchOutlined, ReloadOutlined, TeamOutlined } from '@ant-design/icons'
import { getTechnicalCommittees } from '../../api/standards'
import { useAccess } from '../../hooks/useAccess'

const { Title, Text } = Typography

const REGIONS = [
  '全部', '北京', '上海', '天津', '重庆', '河北', '山西', '辽宁', '吉林',
  '黑龙江', '江苏', '浙江', '安徽', '福建', '江西', '山东', '河南', '湖北',
  '湖南', '广东', '海南', '四川', '贵州', '云南', '陕西', '甘肃', '青海',
  '内蒙古', '广西', '西藏', '宁夏', '新疆',
]


export default function CommitteePage() {
  const isMobile = useIsMobile()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [region, setRegion] = useState<string | undefined>(undefined)
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const { requireLogin } = useAccess()

  const doSearch = async (p = 1) => {
    if (!requireLogin()) return
    setLoading(true)
    try {
      const q = [keyword, region && region !== '全部' ? region : ''].filter(Boolean).join(' ')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await getTechnicalCommittees({ q: q || undefined, page: p, page_size: 20 })
      setItems(res?.items || res?.data || [])
      setTotal(res?.total || 0)
      setPage(p)
    } catch { /* ignore */ }
    setLoading(false)
  }

  return (
    <div>
      <Title level={4}><TeamOutlined /> 技术委员会查询</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        查询全国标准化技术委员会信息，包括委员会编号、名称、秘书处、业务范围等
      </Text>

      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <Input
            placeholder="输入委员会名称或编号"
            prefix={<SearchOutlined />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => doSearch(1)}
            style={{ width: 300 }}
            allowClear
          />
          <Select
            placeholder="选择地区"
            value={region}
            onChange={setRegion}
            style={{ width: 140 }}
            allowClear
            options={REGIONS.map((r) => ({ label: r, value: r }))}
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => doSearch(1)} loading={loading}>
            查询
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => { setKeyword(''); setRegion(undefined); setItems([]); setTotal(0) }}>
            重置
          </Button>
        </Space>
      </Card>

      <Card>
        <Table scroll={{ x: "max-content" }}
          rowKey={(r, i) => r.code || r.id || `${i}`}
          dataSource={items}
          loading={loading}
          pagination={{
            current: page,
            total,
            pageSize: 20,
            showTotal: (t) => `共 ${t} 个委员会`,
            onChange: (p) => doSearch(p),
          }}
          columns={[
            { title: '委员会编号', dataIndex: 'code', width: isMobile ? 120 : 160 },
            { title: '委员会名称', dataIndex: 'name', ellipsis: true },
            { title: '秘书处', dataIndex: 'secretariat', width: 200, ellipsis: true, hidden: isMobile },
            { title: '业务范围', dataIndex: 'scope', ellipsis: true, hidden: isMobile },
          ].filter(c => !('hidden' in c && c.hidden))}
        />
      </Card>
    </div>
  )
}
