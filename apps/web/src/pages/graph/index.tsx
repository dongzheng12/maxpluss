/**
 * 标准图谱 — 节点式可视化布局
 * 中心标准 + 三组关联（版本链/相关标准/系列标准）
 */
import { useState, useEffect } from 'react'
import { Input, Typography, Space, Tag, Spin, Empty, Button, Card } from 'antd'
import { SearchOutlined, NodeIndexOutlined, SwapOutlined, ApartmentOutlined, BookOutlined } from '@ant-design/icons'
import { getStandardRelations, quickSearch } from '../../api/standards'
import { useAccess } from '../../hooks/useAccess'
import { useNavigate, useSearchParams } from 'react-router-dom'

const { Title, Text } = Typography

interface Candidate { code: string; name: string; status?: string }

const STATUS_COLOR: Record<string, string> = {
  '现行': '#52c41a', '废止': '#ff4d4f', '即将实施': '#1677ff',
}

export default function GraphPage() {
  const [keyword, setKeyword] = useState('')
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [loading, setLoading] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [graph, setGraph] = useState<any>(null)
  const [searched, setSearched] = useState(false)
  const { checkAndConsume } = useAccess()
  const nav = useNavigate()
  const [searchParams] = useSearchParams()

  useEffect(() => {
    const code = searchParams.get('code')
    if (code) { setKeyword(code); loadGraph(code) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doSearch = async (q?: string) => {
    const term = (q || keyword).trim()
    if (!term) return
    setSearchLoading(true); setSearched(true); setGraph(null)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await quickSearch(term, 6)
      const results = res?.results || res?.data || []
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setCandidates(results.map((s: any) => ({ code: s.code, name: s.name, status: s.status })))
    } catch { setCandidates([]) }
    setSearchLoading(false)
  }

  const loadGraph = async (code: string) => {
    if (!checkAndConsume('graph')) return
    setLoading(true); setCandidates([]); setKeyword(code)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d: any = await getStandardRelations(code)
      if (!d || d.error) { setGraph(null); setLoading(false); return }
      const rel = d.relations || {}
      const seriesItems = rel.series?.items || []
      const versionItems = rel.versions?.items || []
      const similarItems = rel.similar?.items || []
      setGraph({
        code: d.code, name: d.name || '',
        totalRelations: d.total_relations || (versionItems.length + 1 + similarItems.length + seriesItems.length),
        seriesBase: rel.series?.base || '',
        metrics: {
          versionCount: versionItems.length + 1,
          similarCount: similarItems.length,
          seriesCount: seriesItems.length,
        },
        chain: [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ...versionItems.map((v: any) => ({ code: v.code, name: v.name, isCurrent: false })),
          { code: d.code, name: d.name || '', isCurrent: true },
        ],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        related: similarItems.map((s: any) => ({ code: s.code, name: s.name })),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        library: seriesItems.map((s: any) => ({ code: s.code, name: s.name, status: s.status || '' })),
      })
    } catch { setGraph(null) }
    setLoading(false)
  }

  const goDetail = (code: string) => nav(`/standards/${encodeURIComponent(code)}`)

  return (
    <div>
      <Title level={4}><NodeIndexOutlined /> 标准图谱</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        输入标准编号或名称，查看标准的版本更替链、关联标准和系列标准信息
      </Text>

      {/* 搜索栏 */}
      <Card style={{ marginBottom: 16 }}>
        <Space>
          <Input
            placeholder="输入标准编号或名称，如 GB/T 1.1"
            prefix={<SearchOutlined />}
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value); if (e.target.value.trim()) doSearch(e.target.value.trim()) }}
            onPressEnter={() => doSearch()}
            style={{ width: 400 }}
            allowClear
          />
          <Button type="primary" icon={<SearchOutlined />} onClick={() => doSearch()} loading={searchLoading}>搜索</Button>
        </Space>
      </Card>

      {/* 候选列表 */}
      {candidates.length > 0 && (
        <Card title="请选择一个标准查看图谱" style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {candidates.map((item) => (
              <div
                key={item.code}
                onClick={() => loadGraph(item.code)}
                style={{
                  padding: '12px 16px', borderRadius: 8, border: '1px solid #f0f0f0',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
                  transition: 'all 0.2s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#1677ff'; e.currentTarget.style.background = '#f0f5ff' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#f0f0f0'; e.currentTarget.style.background = 'transparent' }}
              >
                <Text strong style={{ color: '#1677ff', minWidth: 180 }}>{item.code}</Text>
                <Text style={{ flex: 1 }}>{item.name}</Text>
                {item.status && <Tag color={item.status === '现行' ? 'green' : item.status === '废止' ? 'red' : 'blue'}>{item.status}</Tag>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {searched && !searchLoading && candidates.length === 0 && !graph && !loading && (
        <Card><Empty description="未找到匹配的标准，请调整关键词" /></Card>
      )}

      {loading && (
        <Card style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" tip="正在加载标准图谱..." />
        </Card>
      )}

      {/* ===== 图谱可视化 ===== */}
      {!loading && graph && (
        <div style={{ background: '#f6f8fc', borderRadius: 16, padding: 32, position: 'relative', overflow: 'hidden' }}>

          {/* 统计概览 */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 32, justifyContent: 'center' }}>
            {[
              { icon: <SwapOutlined />, label: '版本链', value: graph.metrics.versionCount, color: '#722ed1' },
              { icon: <ApartmentOutlined />, label: '相关标准', value: graph.metrics.similarCount, color: '#1677ff' },
              { icon: <BookOutlined />, label: '系列标准', value: graph.metrics.seriesCount, color: '#13c2c2' },
            ].map((m) => (
              <div key={m.label} style={{
                background: '#fff', borderRadius: 12, padding: '16px 28px',
                display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
              }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 10,
                  background: `${m.color}15`, color: m.color,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
                }}>{m.icon}</div>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#1a2236', lineHeight: 1.2 }}>{m.value}</div>
                  <div style={{ fontSize: 12, color: '#8a94a5' }}>{m.label}</div>
                </div>
              </div>
            ))}
          </div>

          {/* 图谱主体：三列布局 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 32, alignItems: 'start' }}>

            {/* 左列：版本链 */}
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: '#722ed1', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
                <SwapOutlined /> 版本更替链
              </div>
              <div style={{ position: 'relative', paddingLeft: 20 }}>
                {/* 竖线 */}
                <div style={{
                  position: 'absolute', left: 8, top: 12, bottom: 12, width: 2,
                  background: 'linear-gradient(180deg, #722ed1 0%, #d3adf7 100%)',
                }} />
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {graph.chain.map((item: any, i: number) => (
                  <div key={item.code} style={{ position: 'relative', marginBottom: i < graph.chain.length - 1 ? 12 : 0 }}>
                    {/* 节点圆点 */}
                    <div style={{
                      position: 'absolute', left: -16, top: 14, width: 14, height: 14, borderRadius: '50%',
                      border: `3px solid ${item.isCurrent ? '#722ed1' : '#d3adf7'}`,
                      background: item.isCurrent ? '#722ed1' : '#fff', zIndex: 1,
                    }} />
                    <div
                      onClick={() => item.isCurrent ? undefined : loadGraph(item.code)}
                      style={{
                        background: item.isCurrent ? 'linear-gradient(135deg, #f9f0ff, #efdbff)' : '#fff',
                        border: `1.5px solid ${item.isCurrent ? '#722ed1' : '#e8e8e8'}`,
                        borderRadius: 10, padding: '12px 16px', cursor: item.isCurrent ? 'default' : 'pointer',
                        transition: 'all 0.2s',
                      }}
                      onMouseEnter={(e) => !item.isCurrent && (e.currentTarget.style.borderColor = '#722ed1')}
                      onMouseLeave={(e) => !item.isCurrent && (e.currentTarget.style.borderColor = '#e8e8e8')}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <Tag color={item.isCurrent ? 'purple' : 'default'} style={{ margin: 0, fontSize: 11 }}>
                          {item.isCurrent ? '当前版本' : '历史版本'}
                        </Tag>
                        <Text style={{ fontSize: 11, color: '#8a94a5', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); goDetail(item.code) }}>详情 &rarr;</Text>
                      </div>
                      <Text strong style={{ fontSize: 13, color: '#1a2236' }}>{item.code}</Text>
                      {item.name && <div style={{ fontSize: 12, color: '#666', marginTop: 2, lineHeight: 1.4 }}>{item.name}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 中心节点 */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 40 }}>
              {/* 连线指示 */}
              <div style={{ width: 2, height: 20, background: '#d9d9d9' }} />
              <div style={{
                width: 200, minHeight: 200, borderRadius: '50%',
                background: 'linear-gradient(135deg, #1677ff, #4096ff)',
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                padding: 24, textAlign: 'center', boxShadow: '0 8px 32px rgba(22, 119, 255, 0.25)',
                position: 'relative',
              }}>
                {/* 光晕 */}
                <div style={{
                  position: 'absolute', inset: -8, borderRadius: '50%',
                  border: '2px solid rgba(22, 119, 255, 0.15)',
                }} />
                <div style={{
                  position: 'absolute', inset: -18, borderRadius: '50%',
                  border: '1px solid rgba(22, 119, 255, 0.08)',
                }} />
                <NodeIndexOutlined style={{ fontSize: 28, color: '#fff', marginBottom: 8, opacity: 0.9 }} />
                <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', lineHeight: 1.3, wordBreak: 'break-all' }}>
                  {graph.code}
                </div>
                {graph.name && (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)', marginTop: 6, lineHeight: 1.3, maxWidth: 160 }}>
                    {graph.name}
                  </div>
                )}
                <div style={{
                  marginTop: 10, fontSize: 11, color: 'rgba(255,255,255,0.7)',
                  background: 'rgba(255,255,255,0.15)', borderRadius: 10, padding: '2px 10px',
                }}>
                  {graph.totalRelations} 个关联
                </div>
              </div>
              <div style={{ width: 2, height: 20, background: '#d9d9d9' }} />
              <Button type="link" size="small" onClick={() => goDetail(graph.code)} style={{ fontSize: 12 }}>
                查看详情 &rarr;
              </Button>
            </div>

            {/* 右列：相关标准 + 系列标准 */}
            <div>
              {/* 相关标准 */}
              {graph.related.length > 0 && (
                <div style={{ marginBottom: 28 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#1677ff', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ApartmentOutlined /> 语义相关标准
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {graph.related.map((item: any) => (
                      <div
                        key={item.code}
                        style={{
                          background: '#fff', border: '1.5px solid #e8e8e8', borderRadius: 10,
                          padding: '10px 14px', cursor: 'pointer', transition: 'all 0.2s',
                          maxWidth: 240, flex: '1 1 200px',
                        }}
                        onClick={() => loadGraph(item.code)}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#1677ff'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(22,119,255,0.12)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e8e8e8'; e.currentTarget.style.boxShadow = 'none' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#1677ff', flexShrink: 0 }} />
                          <Text strong style={{ fontSize: 12, color: '#1677ff' }}>{item.code}</Text>
                        </div>
                        {item.name && <div style={{ fontSize: 11, color: '#666', lineHeight: 1.4 }}>{item.name}</div>}
                        <Text style={{ fontSize: 10, color: '#b0b0b0', cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); goDetail(item.code) }}>详情 &rarr;</Text>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 系列标准 */}
              {graph.library.length > 0 && (
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#13c2c2', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <BookOutlined /> 系列标准（分册）
                    {graph.seriesBase && <Tag color="cyan" style={{ margin: 0, fontSize: 11 }}>{graph.seriesBase} 系列</Tag>}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                    {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                    {graph.library.map((item: any) => (
                      <div
                        key={item.code}
                        style={{
                          background: '#fff', border: '1.5px solid #e8e8e8', borderRadius: 10,
                          padding: '10px 14px', cursor: 'pointer', transition: 'all 0.2s',
                          maxWidth: 240, flex: '1 1 200px',
                        }}
                        onClick={() => goDetail(item.code)}
                        onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#13c2c2'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(19,194,194,0.12)' }}
                        onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e8e8e8'; e.currentTarget.style.boxShadow = 'none' }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#13c2c2', flexShrink: 0 }} />
                          <Text strong style={{ fontSize: 12, color: '#1a2236' }}>{item.code}</Text>
                        </div>
                        {item.name && <div style={{ fontSize: 11, color: '#666', lineHeight: 1.4 }}>{item.name}</div>}
                        {item.status && (
                          <Tag color={STATUS_COLOR[item.status] ? (item.status === '现行' ? 'green' : item.status === '废止' ? 'red' : 'blue') : 'default'}
                            style={{ marginTop: 4, fontSize: 10 }}>{item.status}</Tag>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {graph.related.length === 0 && graph.library.length === 0 && (
                <div style={{ textAlign: 'center', padding: 40, color: '#b0b0b0' }}>
                  暂无相关标准或系列标准
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
