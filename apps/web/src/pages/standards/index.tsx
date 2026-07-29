import { useState, useEffect, useRef } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { Input, Table, Tag, Select, Space, Card, Typography, Badge, Segmented, Alert, Button, Tabs } from 'antd'
import { SearchOutlined, ReloadOutlined, AppstoreOutlined } from '@ant-design/icons'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { searchStandards, getIndustryStandards, type Standard } from '../../api/standards'
import { useAccess } from '../../hooks/useAccess'

const { Search } = Input
const { Text } = Typography

const statusColors: Record<string, string> = {
  '现行': 'green',
  '即将实施': 'orange',
  '暂不实施': 'orange',
  '废止': 'default',
  '作废': 'default',
  '被代替': 'default',
}

// match_type → 标签：仅对「精准」命中（code_match）显示 tag；
// fts_match / name_match 不展示「模糊」标签（match_type 字段仍由 engine 返回，
// 前端保留接收以便后续统计/排序，但不在结果卡片 UI 上呈现）
const matchTypeLabel: Record<string, { text: string; color: string }> = {
  code_match: { text: '精准', color: 'blue' },
}

const categories = [
  { label: '全部', value: 'all' },
  { label: '国标', value: 'national' },
  { label: '行业标准', value: 'industry' },
  { label: '团体标准', value: 'group' },
  { label: '地方标准', value: 'local' },
  { label: '国际标准', value: 'international' },
]

/** 行业推荐 — 与小程序 industry/index.js 保持一致 */
const INDUSTRIES = [
  '综合', '农业', '医药', '矿业', '石油', '能源', '化工', '冶金',
  '机械', '电气', '电子信息', '通信', '仪器仪表', '建筑', '建材',
  '公路交通', '铁路', '车辆', '船舶', '航空航天', '纺织', '食品', '日用品', '环保',
]
const HOT_TAGS = ['食品', '机械', '医药', '焊接', '建材', '化工', '电气', '纺织']
const TYPE_LABEL_MAP: Record<string, string> = {
  terminology: '术语标准', symbol: '符号标准', classification: '分类标准',
  test_method: '试验方法', specification: '规范', code_of_practice: '规程',
  guide: '指南', product: '产品标准', management_system: '管理体系',
}

export default function StandardsPage() {
  const isMobile = useIsMobile()
  const nav = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // ── 搜索模式：keyword（关键词） | industry（行业推荐）
  const mode = searchParams.get('mode') === 'industry' ? 'industry' : 'keyword'

  // ── 关键词搜索状态
  const [items, setItems] = useState<Standard[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({})
  const { isLoggedIn, isPaid, checkAndConsume, requireLogin } = useAccess()
  const hasConsumedRef = useRef(false)

  const q = searchParams.get('q') || ''
  const category = searchParams.get('category') || 'all'
  const status = searchParams.get('status') || ''
  const page = parseInt(searchParams.get('page') || '1')
  const sortBy = searchParams.get('sort_by') || ''

  const initialQRef = useRef(q)
  if (initialQRef.current && !hasConsumedRef.current) {
    hasConsumedRef.current = true
  }

  // ── 行业推荐状态
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [indAllStandards, setIndAllStandards] = useState<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [indFiltered, setIndFiltered] = useState<any[]>([])
  const [indLoading, setIndLoading] = useState(false)
  const [indKeyword, setIndKeyword] = useState('')
  const [indIndustry, setIndIndustry] = useState<string | undefined>(undefined)
  const [indTypeFilter, setIndTypeFilter] = useState('')
  const [indTypeDist, setIndTypeDist] = useState<Record<string, number>>({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [indByType, setIndByType] = useState<Record<string, any[]>>({})

  const doSearch = async (keyword: string, cat: string, st: string, pg: number, sb: string) => {
    if (!keyword.trim()) return
    if (!hasConsumedRef.current) {
      if (!checkAndConsume('search')) return
      hasConsumedRef.current = true
    }
    setLoading(true)
    try {
      const res = await searchStandards({
        q: keyword,
        category: cat === 'all' ? undefined : cat,
        status: st || undefined,
        page: pg,
        page_size: 20,
        sort_by: sb || undefined,
      })
      setItems(res.items || [])
      setTotal(res.total || 0)
      if (res.status_counts) setStatusCounts(res.status_counts)
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (q) doSearch(q, category, status, page, sortBy)
  }, [q, category, status, page, sortBy])

  const updateParams = (updates: Record<string, string>) => {
    const next = new URLSearchParams(searchParams)
    Object.entries(updates).forEach(([k, v]) => {
      if (v) next.set(k, v)
      else next.delete(k)
    })
    setSearchParams(next)
  }

  // ── 行业推荐搜索
  const doIndSearch = async (q?: string) => {
    const searchTerm = q || indIndustry || indKeyword
    if (!searchTerm?.trim()) return
    if (!requireLogin()) return
    setIndLoading(true)
    setIndTypeFilter('')
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await getIndustryStandards(searchTerm.trim())
      const mandatory = res?.mandatory || []
      const recommended = res?.recommended || []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const combined = [...mandatory, ...recommended].filter((s: any) => s.status !== '废止')
      setIndAllStandards(combined)
      setIndFiltered(combined)
      setIndByType(res?.by_type || {})
      setIndTypeDist(res?.type_distribution || {})
    } catch {
      setIndAllStandards([]); setIndFiltered([]); setIndByType({}); setIndTypeDist({})
    }
    setIndLoading(false)
  }

  const applyIndTypeFilter = (typeKey: string) => {
    setIndTypeFilter(typeKey)
    if (!typeKey) { setIndFiltered(indAllStandards); return }
    if (indByType[typeKey]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setIndFiltered(indByType[typeKey].filter((s: any) => s.status !== '废止'))
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setIndFiltered(indAllStandards.filter((s: any) =>
        (s.type_tags || []).some((t: string) => t.includes(typeKey))
      ))
    }
  }

  const columns = [
    {
      title: '标准编号',
      dataIndex: 'code',
      width: isMobile ? 140 : 200,
      render: (code: string, row: Standard) => (
        <Space size={4} wrap>
          <a onClick={() => nav(`/standards/${encodeURIComponent(code)}`)}>{code}</a>
          {row.match_type && matchTypeLabel[row.match_type] && (
            <Tag color={matchTypeLabel[row.match_type].color} style={{ fontSize: 11, marginInlineEnd: 0 }}>
              {matchTypeLabel[row.match_type].text}
            </Tag>
          )}
        </Space>
      ),
    },
    { title: '标准名称', dataIndex: 'name', ellipsis: true },
    { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => <Tag color={statusColors[s] || 'default'}>{s || '-'}</Tag> },
    { title: '来源', dataIndex: 'source', width: 100, ellipsis: true, render: (v: string) => v || '-', hidden: isMobile },
  ].filter(c => !('hidden' in c && c.hidden))

  const indColumns = [
    {
      title: '标准编号', dataIndex: 'code', width: isMobile ? 140 : 280,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (code: string, row: any) => (
        <Space size={4} wrap>
          <Button type="link" size="small" onClick={() => nav(`/standards/${encodeURIComponent(code)}`)}>{code}</Button>
          {row.match_type && matchTypeLabel[row.match_type as string] && (
            <Tag color={matchTypeLabel[row.match_type as string].color} style={{ fontSize: 11, marginInlineEnd: 0 }}>
              {matchTypeLabel[row.match_type as string].text}
            </Tag>
          )}
        </Space>
      ),
    },
    { title: '标准名称', dataIndex: 'name', ellipsis: true },
    {
      title: '状态', dataIndex: 'status', width: 100,
      render: (s: string) => <Tag color={statusColors[s] || 'default'}>{s || '-'}</Tag>,
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
  ].filter(c => !('hidden' in c && c.hidden))

  const alerts = (
    <>
      {!isLoggedIn && (
        <Alert message="登录后可使用完整搜索功能" type="info" showIcon closable
          action={<Button size="small" type="primary" onClick={() => nav('/login')}>登录</Button>}
          style={{ marginBottom: 16 }} />
      )}
      {isLoggedIn && !isPaid && (
        <Alert message="免费用户每天可搜索 5 次，升级会员无限制" type="warning" showIcon closable
          action={<Button size="small" onClick={() => nav('/membership')}>查看会员</Button>}
          style={{ marginBottom: 16 }} />
      )}
    </>
  )

  return (
    <div>
      {alerts}
      <Tabs
        activeKey={mode}
        onChange={(key) => updateParams({ mode: key === 'industry' ? 'industry' : '', q: '', page: '1', category: '', status: '' })}
        items={[
          { key: 'keyword', label: '关键词搜索' },
          { key: 'industry', label: <span><AppstoreOutlined /> 按行业推荐</span> },
        ]}
        style={{ marginBottom: 4 }}
      />

      {mode === 'keyword' && (
        <>
          <Card style={{ marginBottom: 16 }}>
            <Space direction="vertical" style={{ width: '100%' }} size="middle">
              <Search
                placeholder="搜索标准编号、名称或关键词..."
                enterButton="搜索"
                size="large"
                defaultValue={q}
                onSearch={(v) => updateParams({ q: v, page: '1' })}
                allowClear
              />
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <Segmented
                  options={categories}
                  value={category}
                  onChange={(v) => updateParams({ category: v as string, page: '1' })}
                />
              </div>
              <Space wrap>
                {Object.keys(statusCounts).length > 0 && (
                  <Select
                    placeholder="按状态筛选"
                    allowClear
                    value={status || undefined}
                    onChange={(v) => updateParams({ status: v || '', page: '1' })}
                    style={{ width: 160 }}
                    options={Object.entries(statusCounts).map(([k, cnt]) => ({
                      label: (
                        <Space>
                          <Badge color={statusColors[k] || '#999'} />
                          {k}
                          <Text type="secondary">({cnt})</Text>
                        </Space>
                      ),
                      value: k,
                    }))}
                  />
                )}
                <Select
                  placeholder="排序"
                  allowClear
                  value={sortBy || undefined}
                  onChange={(v) => updateParams({ sort_by: v || '', page: '1' })}
                  style={{ width: 180 }}
                  options={[
                    { label: '默认（相关度）', value: '' },
                    { label: '按实施时间 ↓ 新→旧', value: 'impl_date_desc' },
                    { label: '按实施时间 ↑ 旧→新', value: 'impl_date_asc' },
                  ]}
                />
              </Space>
            </Space>
          </Card>
          <Card>
            <Table
              rowKey="code"
              columns={columns}
              dataSource={items}
              loading={loading}
              pagination={{
                current: page,
                total,
                pageSize: 20,
                showTotal: (t) => `共 ${t} 条结果`,
                onChange: (p) => updateParams({ page: String(p) }),
              }}
              locale={{ emptyText: q ? '未找到匹配的标准' : '请输入关键词开始搜索' }}
            />
          </Card>
        </>
      )}

      {mode === 'industry' && (
        <>
          <Card style={{ marginBottom: 16 }}>
            <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>
              按行业领域查询相关标准，涵盖 24 个行业大类
            </Text>
            <Space wrap>
              <Select
                placeholder="选择行业"
                value={indIndustry}
                onChange={(v) => { setIndIndustry(v); if (v) doIndSearch(v) }}
                style={{ width: 160 }}
                allowClear showSearch
                options={INDUSTRIES.map((i) => ({ label: i, value: i }))}
              />
              <Input
                placeholder="输入关键词细化搜索"
                prefix={<SearchOutlined />}
                value={indKeyword}
                onChange={(e) => setIndKeyword(e.target.value)}
                onPressEnter={() => doIndSearch()}
                style={{ width: 240 }}
                allowClear
              />
              <Button type="primary" icon={<SearchOutlined />} onClick={() => doIndSearch()} loading={indLoading}>
                搜索
              </Button>
              <Button icon={<ReloadOutlined />} onClick={() => {
                setIndKeyword(''); setIndIndustry(undefined); setIndTypeFilter('')
                setIndAllStandards([]); setIndFiltered([]); setIndTypeDist({}); setIndByType({})
              }}>
                重置
              </Button>
            </Space>
            <div style={{ marginTop: 12 }}>
              <Text type="secondary" style={{ marginRight: 8 }}>热门：</Text>
              {HOT_TAGS.map((tag) => (
                <Tag key={tag} color="blue" style={{ cursor: 'pointer', marginBottom: 4 }}
                  onClick={() => { setIndKeyword(tag); setIndIndustry(undefined); doIndSearch(tag) }}>
                  {tag}
                </Tag>
              ))}
            </div>
          </Card>

          {Object.keys(indTypeDist).length > 0 && (
            <Card style={{ marginBottom: 16 }}>
              <Space wrap>
                <Text type="secondary">按类型筛选：</Text>
                <Tag color={!indTypeFilter ? 'blue' : 'default'} style={{ cursor: 'pointer' }}
                  onClick={() => applyIndTypeFilter('')}>
                  全部 ({indAllStandards.length})
                </Tag>
                {Object.entries(indTypeDist).map(([key, count]) => (
                  <Tag key={key} color={indTypeFilter === key ? 'blue' : 'default'}
                    style={{ cursor: 'pointer' }} onClick={() => applyIndTypeFilter(key)}>
                    {TYPE_LABEL_MAP[key] || key} ({count})
                  </Tag>
                ))}
              </Space>
            </Card>
          )}

          <Card>
            <Table scroll={{ x: 'max-content' }}
              rowKey={(r, i) => r.code || `${i}`}
              dataSource={indFiltered}
              loading={indLoading}
              pagination={{ pageSize: 20, showTotal: (t) => `共 ${t} 条结果` }}
              locale={{ emptyText: '请选择行业或输入关键词搜索' }}
              columns={indColumns}
            />
          </Card>
        </>
      )}
    </div>
  )
}
