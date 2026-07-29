/**
 * 行业标准推荐 — 与小程序 industry/index.js 完全对齐
 *
 * API: GET /api/v1/industry-standards?q=食品
 * 返回: { matched, mandatory: [...], recommended: [...], by_type: {...}, type_distribution: {...} }
 */
import { useState } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Card, Table, Input, Select, Typography, Space, Tag, Button } from 'antd'
import { SearchOutlined, ReloadOutlined, AppstoreOutlined } from '@ant-design/icons'
import { getIndustryStandards } from '../../api/standards'
import { useAccess } from '../../hooks/useAccess'
import { useNavigate } from 'react-router-dom'

const { Title, Text } = Typography

/** 与小程序 industry/index.js 中的 INDUSTRIES 一致 */
const INDUSTRIES = [
  '综合', '农业', '医药', '矿业', '石油', '能源', '化工', '冶金',
  '机械', '电气', '电子信息', '通信', '仪器仪表', '建筑', '建材',
  '公路交通', '铁路', '车辆', '船舶', '航空航天', '纺织', '食品', '日用品', '环保',
]

/** 与小程序 hot tags 一致 */
const HOT_TAGS = ['食品', '机械', '医药', '焊接', '建材', '化工', '电气', '纺织']

/** 与小程序 type_distribution 一致 */
const TYPE_LABEL_MAP: Record<string, string> = {
  terminology: '术语标准',
  symbol: '符号标准',
  classification: '分类标准',
  test_method: '试验方法',
  specification: '规范',
  code_of_practice: '规程',
  guide: '指南',
  product: '产品标准',
  management_system: '管理体系',
}


export default function IndustryPage() {
  const isMobile = useIsMobile()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [allStandards, setAllStandards] = useState<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [filtered, setFiltered] = useState<any[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [industry, setIndustry] = useState<string | undefined>(undefined)
  const [typeFilter, setTypeFilter] = useState('')
  const [typeDist, setTypeDist] = useState<Record<string, number>>({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [byType, setByType] = useState<Record<string, any[]>>({})
  const { requireLogin } = useAccess()
  const nav = useNavigate()

  const doSearch = async (q?: string) => {
    const searchTerm = q || industry || keyword
    if (!searchTerm?.trim()) return
    if (!requireLogin()) return
    setLoading(true)
    setTypeFilter('')
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await getIndustryStandards(searchTerm.trim())

      // 与小程序一致：合并 mandatory + recommended，过滤掉废止
      const mandatory = (res?.mandatory || [])
      const recommended = (res?.recommended || [])
      const combined = [...mandatory, ...recommended].filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (s: any) => s.status !== '废止'
      )

      setAllStandards(combined)
      setFiltered(combined)
      setByType(res?.by_type || {})
      setTypeDist(res?.type_distribution || {})
    } catch {
      setAllStandards([])
      setFiltered([])
      setByType({})
      setTypeDist({})
    }
    setLoading(false)
  }

  /** 按类型筛选 — 与小程序 applyFilter 一致 */
  const applyTypeFilter = (typeKey: string) => {
    setTypeFilter(typeKey)
    if (!typeKey) {
      setFiltered(allStandards)
      return
    }
    // 优先用 by_type 数据，否则按 type_tags 过滤
    if (byType[typeKey]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setFiltered(byType[typeKey].filter((s: any) => s.status !== '废止'))
    } else {
      setFiltered(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        allStandards.filter((s: any) =>
          (s.type_tags || []).some((t: string) => t.includes(typeKey))
        )
      )
    }
  }

  return (
    <div>
      <Title level={4}><AppstoreOutlined /> 行业标准推荐</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        按行业领域查询相关标准，涵盖24个行业大类，快速找到您所在行业的适用标准
      </Text>

      <Card style={{ marginBottom: 16 }}>
        <Space wrap>
          <Select
            placeholder="选择行业"
            value={industry}
            onChange={(v) => { setIndustry(v); if (v) doSearch(v) }}
            style={{ width: 160 }}
            allowClear
            showSearch
            options={INDUSTRIES.map((i) => ({ label: i, value: i }))}
          />
          <Input
            placeholder="输入关键词细化搜索"
            prefix={<SearchOutlined />}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onPressEnter={() => doSearch()}
            style={{ width: 260 }}
            allowClear
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => doSearch()} loading={loading}>
            搜索
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => {
            setKeyword(''); setIndustry(undefined); setTypeFilter('')
            setAllStandards([]); setFiltered([]); setTypeDist({}); setByType({})
          }}>
            重置
          </Button>
        </Space>
        <div style={{ marginTop: 12 }}>
          <Text type="secondary" style={{ marginRight: 8 }}>热门：</Text>
          {HOT_TAGS.map((tag) => (
            <Tag
              key={tag}
              color="blue"
              style={{ cursor: 'pointer', marginBottom: 4 }}
              onClick={() => { setKeyword(tag); setIndustry(undefined); doSearch(tag) }}
            >
              {tag}
            </Tag>
          ))}
        </div>
      </Card>

      {/* 类型筛选 — 与小程序 type_distribution 对应 */}
      {Object.keys(typeDist).length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <Space wrap>
            <Text type="secondary">按类型筛选：</Text>
            <Tag
              color={!typeFilter ? 'blue' : 'default'}
              style={{ cursor: 'pointer' }}
              onClick={() => applyTypeFilter('')}
            >
              全部 ({allStandards.length})
            </Tag>
            {Object.entries(typeDist).map(([key, count]) => (
              <Tag
                key={key}
                color={typeFilter === key ? 'blue' : 'default'}
                style={{ cursor: 'pointer' }}
                onClick={() => applyTypeFilter(key)}
              >
                {TYPE_LABEL_MAP[key] || key} ({count})
              </Tag>
            ))}
          </Space>
        </Card>
      )}

      <Card>
        <Table scroll={{ x: "max-content" }}
          rowKey={(r, i) => r.code || `${i}`}
          dataSource={filtered}
          loading={loading}
          pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条结果` }}
          locale={{ emptyText: '请选择行业或输入关键词搜索' }}
          columns={[
            {
              title: '标准编号', dataIndex: 'code', width: isMobile ? 140 : 280,
              render: (code: string) => (
                <Button type="link" size="small" onClick={() => nav(`/standards/${encodeURIComponent(code)}`)}>{code}</Button>
              ),
            },
            { title: '标准名称', dataIndex: 'name', ellipsis: true },
            {
              title: '状态', dataIndex: 'status', width: 100,
              render: (s: string) => (
                <Tag color={s === '现行' ? 'green' : s === '即将实施' ? 'blue' : 'default'}>{s || '-'}</Tag>
              ),
            },
            {
              title: '类型', dataIndex: 'type_tags', width: 140, hidden: isMobile,
              render: (tags: string[]) => (
                <Space wrap size={4}>
                  {(tags || []).slice(0, 2).map((t: string) => (
                    <Tag key={t} style={{ fontSize: 12 }}>{TYPE_LABEL_MAP[t] || t}</Tag>
                  ))}
                </Space>
              ),
            },
            { title: '发布日期', dataIndex: 'pub_date', width: 120, hidden: isMobile },
          ].filter(c => !('hidden' in c && c.hidden))}
        />
      </Card>
    </div>
  )
}
