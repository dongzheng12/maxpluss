import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Card, Descriptions, Tag, Typography, Spin, Button, Space } from 'antd'
import { ArrowLeftOutlined, StarOutlined, StarFilled, ApartmentOutlined } from '@ant-design/icons'
import { getStandardDetail, getStandardRelations } from '../../api/standards'
import { message } from 'antd'

const { Title, Text } = Typography

const statusColors: Record<string, string> = {
  '现行': 'green',
  '即将实施': 'orange',
  '暂不实施': 'orange',
  '废止': 'default',
  '作废': 'default',
  '被代替': 'default',
}

export default function DetailPage() {
  const { code } = useParams()
  const nav = useNavigate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [detail, setDetail] = useState<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [relations, setRelations] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [isFavorite, setIsFavorite] = useState(false)

  // 收藏功能 — localStorage，与小程序逻辑对齐
  const FAVORITES_KEY = 'bxz_favorites'
  const getFavorites = (): string[] => {
    try { return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]') } catch { return [] }
  }
  const toggleFavorite = () => {
    if (!code) return
    const favs = getFavorites()
    const idx = favs.indexOf(code)
    if (idx >= 0) {
      favs.splice(idx, 1)
      setIsFavorite(false)
      message.success('已取消收藏')
    } else {
      favs.push(code)
      setIsFavorite(true)
      message.success('已收藏')
    }
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs))
  }

  useEffect(() => {
    if (!code) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    Promise.all([
      getStandardDetail(code).catch(() => null),
      getStandardRelations(code).catch(() => null),
    ]).then(([d, r]) => {
      setDetail(d)
      setRelations(r)
      setIsFavorite(getFavorites().includes(code))
    }).finally(() => setLoading(false))
  }, [code])

  // 知识图谱节点存在性：versions / series / similar 至少一类有内容
  const hasGraphNode = !!(
    relations?.relations?.versions?.items?.length ||
    relations?.relations?.series?.items?.length ||
    relations?.relations?.similar?.items?.length
  )

  if (loading) return <Spin size="large" style={{ display: 'block', margin: '80px auto' }} />

  if (!detail) {
    return (
      <Card>
        <Text type="secondary">未找到标准 {code}</Text>
        <br />
        <Button onClick={() => nav(-1)} style={{ marginTop: 16 }}>返回</Button>
      </Card>
    )
  }

  return (
    <div>
      <Button icon={<ArrowLeftOutlined />} type="text" onClick={() => nav(-1)} style={{ marginBottom: 16 }}>
        返回搜索
      </Button>

      <Card styles={{ body: { padding: 0 } }}>
        {/* 顶部标准头信息 */}
        <div style={{
          background: 'linear-gradient(135deg, #f0f5ff 0%, #e6f4ff 100%)',
          padding: '24px 28px 20px',
          borderBottom: '1px solid #e8e8e8',
        }}>
          <Space size="middle" align="start">
            <Tag
              color={statusColors[detail.status] || 'default'}
              style={{ fontSize: 14, padding: '2px 12px' }}
            >
              {detail.status}
            </Tag>
            {detail.is_mandatory && <Tag color="red">强制性</Tag>}
          </Space>
          <Title level={4} style={{ marginBottom: 4, marginTop: 12 }}>{detail.code}</Title>
          <Text style={{ fontSize: 16 }}>{detail.name}</Text>
        </div>

        <div style={{ padding: '20px 28px' }}>
          <Descriptions column={2} size="small" style={{ marginBottom: 20 }}>
            {detail.source && (
              <Descriptions.Item label="来源">{detail.source}</Descriptions.Item>
            )}
            {detail.industry && (
              <Descriptions.Item label="行业">{detail.industry}</Descriptions.Item>
            )}
            <Descriptions.Item label="发布日期">{detail.pub_date || '-'}</Descriptions.Item>
            <Descriptions.Item label="实施日期">{detail.impl_date || '-'}</Descriptions.Item>
            {detail.obsolete_date && (
              <Descriptions.Item label="废止日期">{detail.obsolete_date}</Descriptions.Item>
            )}
            <Descriptions.Item label="ICS 分类">
              {detail.ics_code || detail.ics
                ? `${detail.ics_code || detail.ics}${detail.ics_name ? '  ' + detail.ics_name : ''}`
                : '-'}
            </Descriptions.Item>
            <Descriptions.Item label="CCS 分类">
              {detail.ccs
                ? `${detail.ccs}${detail.ccs_name ? '  ' + detail.ccs_name : ''}`
                : '-'}
            </Descriptions.Item>
            {detail.issuing_dept && (
              <Descriptions.Item label="发布机构" span={2}>{detail.issuing_dept}</Descriptions.Item>
            )}
            {detail.publisher && !detail.issuing_dept && (
              <Descriptions.Item label="发布机构" span={2}>{detail.publisher}</Descriptions.Item>
            )}
            {detail.tc_committee && (
              <Descriptions.Item label="归口单位" span={2}>{detail.tc_committee}</Descriptions.Item>
            )}
            {detail.drafting_org && (
              <Descriptions.Item label="起草单位" span={2}>{detail.drafting_org}</Descriptions.Item>
            )}
            {detail.name_en && (
              <Descriptions.Item label="英文名称" span={2}>{detail.name_en}</Descriptions.Item>
            )}
            {detail.replaces && (
              <Descriptions.Item label="代替标准" span={2}>{detail.replaces}</Descriptions.Item>
            )}
            {detail.adopted_intl && (
              <Descriptions.Item label="采用国际标准" span={2}>{detail.adopted_intl}</Descriptions.Item>
            )}
            {detail.pages && (
              <Descriptions.Item label="页数">{detail.pages}</Descriptions.Item>
            )}
            {detail.type_tags?.length > 0 && (
              <Descriptions.Item label="类型">
                {detail.type_tags.map((t: string) => <Tag key={t}>{t}</Tag>)}
              </Descriptions.Item>
            )}
          </Descriptions>

          {/* 摘要/范围（如果 API 返回了的话） */}
          {detail.scope && (
            <div style={{ marginBottom: 20 }}>
              <Text strong style={{ display: 'block', marginBottom: 6 }}>范围</Text>
              <Text type="secondary" style={{
                lineHeight: 1.8, display: '-webkit-box', WebkitLineClamp: 3,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                WebkitBoxOrient: 'vertical' as any, overflow: 'hidden',
              }}>
                {detail.scope}
              </Text>
            </div>
          )}

          <Space>
            {hasGraphNode && (
              <Button
                icon={<ApartmentOutlined />}
                type="primary"
                onClick={() => nav(`/graph?code=${encodeURIComponent(detail.code)}`)}
              >
                查看知识图谱
              </Button>
            )}
            <Button
              icon={isFavorite ? <StarFilled style={{ color: '#faad14' }} /> : <StarOutlined />}
              onClick={toggleFavorite}
            >
              {isFavorite ? '已收藏' : '收藏'}
            </Button>
          </Space>
        </div>
      </Card>

      {/* Relations */}
      {relations && (
        <Card title="关联标准" style={{ marginTop: 16 }}>
          {relations.relations?.versions?.items?.length > 0 && (
            <>
              <Text strong>版本历史</Text>
              <div style={{ margin: '8px 0 16px' }}>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {relations.relations.versions.items.map((v: any) => (
                  <Tag
                    key={v.code}
                    style={{ cursor: 'pointer', marginBottom: 4 }}
                    onClick={() => nav(`/standards/${encodeURIComponent(v.code)}`)}
                  >
                    {v.code} — {v.name}
                  </Tag>
                ))}
              </div>
            </>
          )}
          {relations.relations?.series?.items?.length > 0 && (
            <>
              <Text strong>系列标准</Text>
              <div style={{ margin: '8px 0 16px' }}>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {relations.relations.series.items.map((s: any) => (
                  <Tag
                    key={s.code}
                    style={{ cursor: 'pointer', marginBottom: 4 }}
                    onClick={() => nav(`/standards/${encodeURIComponent(s.code)}`)}
                  >
                    {s.code}
                  </Tag>
                ))}
              </div>
            </>
          )}
          {relations.relations?.similar?.items?.length > 0 && (
            <>
              <Text strong>相似标准</Text>
              <div style={{ margin: '8px 0' }}>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {relations.relations.similar.items.map((s: any) => (
                  <Tag
                    key={s.code}
                    style={{ cursor: 'pointer', marginBottom: 4 }}
                    onClick={() => nav(`/standards/${encodeURIComponent(s.code)}`)}
                  >
                    {s.code} — {s.name}
                  </Tag>
                ))}
              </div>
            </>
          )}
          {!relations.relations && <Text type="secondary">暂无关联标准数据</Text>}
        </Card>
      )}
    </div>
  )
}
