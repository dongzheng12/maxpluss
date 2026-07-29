/**
 * 一句话生架构 — 标准框架大纲 + 附录 + 关联标准
 * POST /api/v1/outline { description, standard_type? }
 */
import { useState } from 'react'
import { Card, Input, Select, Typography, Button, Space, Spin, Empty, Tag, message } from 'antd'
import {
  FileTextOutlined, ThunderboltOutlined, DownOutlined, RightOutlined,
  BookOutlined, LinkOutlined, CopyOutlined,
} from '@ant-design/icons'
import { generateOutline } from '../../api/standards'
import { useAccess } from '../../hooks/useAccess'
import { useNavigate } from 'react-router-dom'

const { Title, Text } = Typography
const { TextArea } = Input

const STANDARD_TYPES = [
  { label: '智能匹配', value: '' },
  { label: '术语标准', value: '术语标准' },
  { label: '符号标准', value: '符号标准' },
  { label: '分类标准', value: '分类标准' },
  { label: '试验方法标准', value: '试验方法标准' },
  { label: '规范标准', value: '规范标准' },
  { label: '规程标准', value: '规程标准' },
  { label: '指南标准', value: '指南标准' },
  { label: '产品标准', value: '产品标准' },
  { label: '管理体系标准', value: '管理体系标准' },
]

const EXAMPLES = ['不锈钢管', '食品添加剂', '焊接操作规程', '智能电网运维指南', '新能源汽车充电桩']


export default function OutlinePage() {
  const [description, setDescription] = useState('')
  const [standardType, setStandardType] = useState('')
  const [loading, setLoading] = useState(false)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [result, setResult] = useState<any>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const { checkAndConsume } = useAccess()
  const nav = useNavigate()

  const doGenerate = async (desc?: string) => {
    const text = (desc || description).trim()
    if (!text) return
    if (!checkAndConsume('outline')) return
    setLoading(true); setResult(null); setExpanded({})
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await generateOutline(text, standardType || undefined)
      if (!res || !res.outline) { setResult(null); setLoading(false); return }
      const exp: Record<string, boolean> = {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      res.outline.forEach((item: any, i: number) => { if (i < 4) exp[item.clause] = true })
      setExpanded(exp)
      setResult(res)
    } catch { setResult(null) }
    setLoading(false)
  }

  const toggleClause = (key: string) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))

  /** 附录类型英中映射 */
  const appTypeLabel = (t: string) => {
    if (!t) return '资料性'
    if (t === 'normative' || t === '规范性') return '规范性'
    if (t === 'informative' || t === '资料性') return '资料性'
    return t
  }
  const isNormative = (t: string) => appTypeLabel(t) === '规范性'

  /** 一键复制全纲 — 包含条款内容、注释、提示、引用、附录、关联标准 */
  const copyOutline = () => {
    if (!result?.outline) return
    const lines: string[] = []
    lines.push(result.matched_template || '标准大纲')
    lines.push('')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result.outline.forEach((clause: any) => {
      lines.push(`${clause.clause}  ${clause.name || clause.title || ''}${clause.editable === false ? '（固定）' : ''}`)
      if (clause.content) lines.push(`    ${clause.content}`)
      if (clause.note) lines.push(`    [注] ${clause.note}`)
      if (clause.hint) lines.push(`    [提示] ${clause.hint}`)
      if (clause.injected_refs?.length) {
        lines.push('    规范性引用文件：')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clause.injected_refs.forEach((ref: any) => {
          lines.push(`      ${ref.code}  ${ref.name || ''}`)
        })
      }
      if (clause.children) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clause.children.forEach((child: any) => {
          lines.push(`  ${child.clause || ''}  ${child.title || child.name || ''}`)
          if (child.content) lines.push(`      ${child.content}`)
          if (child.note) lines.push(`      [注] ${child.note}`)
          if (child.hint) lines.push(`      [提示] ${child.hint}`)
          if (child.children) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            child.children.forEach((sub: any) => {
              lines.push(`    ${sub.clause || ''}  ${sub.title || sub.name || ''}`)
              if (sub.content) lines.push(`        ${sub.content}`)
            })
          }
        })
      }
    })
    if (result.appendices?.length) {
      lines.push('')
      lines.push('附录')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.appendices.forEach((app: any, i: number) => {
        const label = app.label || `附录${String.fromCharCode(65 + i)}`
        lines.push(`${label}（${appTypeLabel(app.type)}）${app.title || ''}`)
        if (app.content) lines.push(`    ${app.content}`)
      })
    }
    if (result.related_standards?.length) {
      lines.push('')
      lines.push('关联标准')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result.related_standards.forEach((std: any) => {
        lines.push(`  ${std.code || ''}  ${std.name || ''}`)
      })
    }
    const text = lines.join('\n')
    const doFallback = () => {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      message.success('大纲已复制到剪贴板')
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text)
        .then(() => message.success('大纲已复制到剪贴板'))
        .catch(() => doFallback())
    } else {
      doFallback()
    }
  }

  return (
    <div>
      <Title level={4}><FileTextOutlined /> AI 编写辅助</Title>
      <Text type="secondary" style={{ display: 'block', marginBottom: 16 }}>
        输入一句话描述您要编写的标准内容，AI 将自动生成符合国标体例的标准框架大纲
      </Text>

      {/* 输入区 */}
      <Card style={{ marginBottom: 16 }}>
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>标准描述</Text>
            <TextArea
              placeholder="请用一句话描述您要编写的标准，例如：食品添加剂使用规范"
              value={description} onChange={(e) => setDescription(e.target.value)}
              rows={3} maxLength={200} showCount
            />
          </div>
          <div>
            <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>快速示例：</Text>
            <Space wrap>
              {EXAMPLES.map((ex) => (
                <Tag key={ex} color="blue" style={{ cursor: 'pointer' }}
                  onClick={() => { setDescription(ex); doGenerate(ex) }}>
                  {ex}
                </Tag>
              ))}
            </Space>
          </div>
          <Space>
            <Select value={standardType} onChange={setStandardType} style={{ width: 180 }} options={STANDARD_TYPES} />
            <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => doGenerate()}
              loading={loading} disabled={!description.trim()}>
              生成大纲
            </Button>
          </Space>
        </Space>
      </Card>

      {loading && (
        <Card style={{ textAlign: 'center', padding: 60 }}>
          <Spin size="large" tip="AI 正在生成标准框架大纲..." />
        </Card>
      )}

      {!loading && result && result.outline && result.outline.length > 0 && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">

          {/* 匹配模板 + 章节数 */}
          <Card style={{ background: 'linear-gradient(135deg, #f0f5ff 0%, #e8f4fd 100%)', border: 'none' }}>
            <div style={{ fontSize: 16, fontWeight: 600, color: '#1a2236', marginBottom: 4 }}>
              {result.matched_template || '标准大纲'}
            </div>
            <Text type="secondary">共 <Text strong>{result.outline.length}</Text> 个章节</Text>
          </Card>

          {/* 大纲树 */}
          <Card
            title="标准框架大纲"
            extra={
              <Button icon={<CopyOutlined />} size="small" onClick={copyOutline}>
                复制大纲
              </Button>
            }
          >
            <div>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {result.outline.map((clause: any) => {
                return (
                  <div key={clause.clause} style={{ marginBottom: 2 }}>
                    <div
                      style={{
                        cursor: 'pointer', padding: '10px 12px', display: 'flex', alignItems: 'center',
                        borderRadius: 8, transition: 'background 0.15s',
                      }}
                      onClick={() => toggleClause(clause.clause)}
                      onMouseEnter={(e) => e.currentTarget.style.background = '#fafafa'}
                      onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                    >
                      {/* 指示条：可编辑蓝色，固定灰色 */}
                      <div style={{
                        width: 3, height: 20, borderRadius: 2, marginRight: 10, flexShrink: 0,
                        background: clause.editable !== false ? '#1677ff' : '#d9d9d9',
                      }} />
                      {expanded[clause.clause]
                        ? <DownOutlined style={{ marginRight: 8, fontSize: 11, color: '#999' }} />
                        : <RightOutlined style={{ marginRight: 8, fontSize: 11, color: '#999' }} />}
                      <Text strong style={{ fontSize: 14 }}>{clause.clause}</Text>
                      {(clause.name || clause.title) && (
                        <Text style={{ marginLeft: 8, fontSize: 14 }}>{clause.name || clause.title}</Text>
                      )}
                      {clause.editable === false && (
                        <Tag color="default" style={{ marginLeft: 8, fontSize: 11 }}>固定</Tag>
                      )}
                    </div>

                    {expanded[clause.clause] && (clause.content || clause.description) && (
                      <div style={{ paddingLeft: 36, paddingBottom: 4 }}>
                        <Text type="secondary" style={{ fontSize: 13, lineHeight: 1.8, display: 'block', marginBottom: 4 }}>
                          {clause.content || clause.description}
                        </Text>
                        {clause.note && (
                          <div style={{ background: '#e6f7ff', border: '1px solid #91d5ff', borderRadius: 6, padding: '6px 12px', marginBottom: 4, fontSize: 12, color: '#096dd9', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                            <span style={{ background: '#1677ff', color: '#fff', borderRadius: '50%', width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, flexShrink: 0 }}>i</span>
                            <span>{clause.note}</span>
                          </div>
                        )}
                        {clause.hint && (
                          <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 6, padding: '6px 12px', marginBottom: 4, fontSize: 12, color: '#ad6800' }}>
                            {clause.hint}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 注入的规范性引用（第2章） */}
                    {expanded[clause.clause] && clause.injected_refs && clause.injected_refs.length > 0 && (
                      <div style={{ paddingLeft: 36, paddingBottom: 8 }}>
                        <Text type="secondary" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, display: 'block' }}>规范性引用文件</Text>
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        {clause.injected_refs.map((ref: any) => (
                          <div key={ref.code} style={{ padding: '4px 0', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Text strong style={{ color: '#1677ff' }}>{ref.code}</Text>
                            <Text type="secondary">{ref.name}</Text>
                          </div>
                        ))}
                      </div>
                    )}

                    {expanded[clause.clause] && clause.children && (
                      <div style={{ paddingLeft: 36, paddingBottom: 8 }}>
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        {clause.children.map((child: any, idx: number) => {
                          const childKey = child.clause || `${clause.clause}-${idx}`
                          return (
                            <div key={childKey}>
                              <div
                                style={{
                                  cursor: child.children?.length ? 'pointer' : 'default',
                                  display: 'flex', alignItems: 'center', padding: '5px 0',
                                }}
                                onClick={() => child.children?.length && toggleClause(childKey)}
                              >
                                {child.children?.length ? (
                                  expanded[childKey]
                                    ? <DownOutlined style={{ marginRight: 8, fontSize: 10, color: '#bbb' }} />
                                    : <RightOutlined style={{ marginRight: 8, fontSize: 10, color: '#bbb' }} />
                                ) : (
                                  <span style={{ marginRight: 8, width: 10, display: 'inline-block' }} />
                                )}
                                <Text style={{ fontSize: 13 }}>
                                  {child.clause || ''} {child.title || child.name || ''}
                                </Text>
                              </div>
                              {/* 子章节描述 */}
                      {(child.content || child.description) && (
                        <div style={{ paddingLeft: 26, paddingBottom: 2 }}>
                          <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.7 }}>
                            {child.content || child.description}
                          </Text>
                          {child.note && (
                            <div style={{ background: '#e6f7ff', border: '1px solid #91d5ff', borderRadius: 6, padding: '4px 10px', marginTop: 4, fontSize: 11, color: '#096dd9', display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                              <span style={{ background: '#1677ff', color: '#fff', borderRadius: '50%', width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, flexShrink: 0 }}>i</span>
                              <span>{child.note}</span>
                            </div>
                          )}
                          {child.hint && (
                            <div style={{ background: '#fffbe6', border: '1px solid #ffe58f', borderRadius: 6, padding: '4px 10px', marginTop: 4, fontSize: 11, color: '#ad6800' }}>
                              {child.hint}
                            </div>
                          )}
                        </div>
                      )}
                      {expanded[childKey] && child.children && (
                                <div style={{ paddingLeft: 26 }}>
                                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                                  {child.children.map((sub: any, si: number) => (
                                    <div key={si} style={{ padding: '3px 0' }}>
                                      <Text type="secondary" style={{ fontSize: 12 }}>
                                        {sub.clause || ''} {sub.title || sub.name || ''}
                                      </Text>
                                      {(sub.content || sub.description) && (
                                        <div style={{ paddingLeft: 18, marginTop: 2 }}>
                                          <Text type="secondary" style={{ fontSize: 11, color: '#aaa', lineHeight: 1.6 }}>
                                            {sub.content || sub.description}
                                          </Text>
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </Card>

          {/* 附录 */}
          {result.appendices && result.appendices.length > 0 && (
            <Card title={<><BookOutlined /> 附录</>}>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {result.appendices.map((app: any, i: number) => (
                <div key={i} style={{
                  padding: '10px 14px', marginBottom: 8, borderRadius: 8,
                  background: isNormative(app.type) ? '#f0f5ff' : '#f6f6f6',
                  border: `1px solid ${isNormative(app.type) ? '#d6e4ff' : '#f0f0f0'}`,
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <Tag color={isNormative(app.type) ? 'blue' : 'default'} style={{ margin: 0 }}>
                    {appTypeLabel(app.type)}附录
                  </Tag>
                  <div>
                    <Text strong style={{ fontSize: 13 }}>{app.label || `附录${String.fromCharCode(65 + i)}`}</Text>
                    {app.title && <Text style={{ marginLeft: 8, fontSize: 13 }}>{app.title}</Text>}
                  </div>
                </div>
              ))}
            </Card>
          )}

          {/* 关联标准 / 规范性引用文件 */}
          {result.related_standards && result.related_standards.length > 0 && (
            <Card title={<><LinkOutlined /> 规范性引用文件</>}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {result.related_standards.map((std: any, i: number) => (
                  <div key={i} style={{
                    padding: '8px 14px', borderRadius: 8, border: '1px solid #f0f0f0',
                    cursor: std.code ? 'pointer' : 'default', transition: 'all 0.2s',
                    flex: '1 1 280px', maxWidth: 380,
                  }}
                    onClick={() => std.code && nav(`/standards/${encodeURIComponent(std.code)}`)}
                    onMouseEnter={(e) => std.code && (e.currentTarget.style.borderColor = '#1677ff')}
                    onMouseLeave={(e) => std.code && (e.currentTarget.style.borderColor = '#f0f0f0')}
                  >
                    <Text strong style={{ fontSize: 12, color: '#1677ff' }}>{std.code || ''}</Text>
                    {std.name && <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>{std.name}</div>}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </Space>
      )}

      {!loading && result && (!result.outline || result.outline.length === 0) && (
        <Card><Empty description="未能生成有效的大纲，请尝试更详细的描述" /></Card>
      )}
      <div style={{
        textAlign: 'center',
        fontSize: 14,
        color: '#8c8c8c',
        padding: '20px 0 12px',
        letterSpacing: 0.2,
      }}>
        内容由 AI 生成，仅供参考
      </div>
    </div>
  )
}
