/**
 * 比对报告详情页 — 支持全库相似度分析 + 1v1 两种报告格式
 * 路由: /compare/report/:taskNo
 * API:  GET /api/app/compare/tasks/:taskNo
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import { useParams, useNavigate } from 'react-router-dom'
import {
  Card, Typography, Tag, Space, Spin, Empty, Button, Alert, Progress,
  message, Table, Tooltip, Statistic, Row, Col, Modal, Result,
} from 'antd'
import {
  LockOutlined, UnlockOutlined, WarningOutlined,
  CheckCircleOutlined, ArrowLeftOutlined, ReloadOutlined,
  SafetyCertificateOutlined, InfoCircleOutlined,
  ExclamationCircleOutlined, FilePdfOutlined,
} from '@ant-design/icons'
import { getCompareTask, unlockCompareReport, retryCompareTask } from '../../api/app'
import CompareUpgradePrompt from '../../components/CompareUpgradePrompt'
import { useAccess } from '../../hooks/useAccess'
import html2canvas from 'html2canvas-pro'
import { jsPDF } from 'jspdf'

const { Title, Text, Paragraph } = Typography

function conclusionAlertType(c: string): 'warning' | 'success' | 'info' {
  if (/风险|问题|重复|废止|缺失|不足|冲突|偏高|超标|存在|注意|需要|建议修|建议替/.test(c)) return 'warning'
  if (/通过|符合|完整|合理|未发现|无明显|低风险/.test(c)) return 'success'
  return 'info'
}

function riskColor(level: string) {
  if (level === 'high') return '#f5222d'
  if (level === 'medium') return '#fa8c16'
  return '#52c41a'
}

function simColor(v: number): string {
  if (v >= 60) return '#f5222d'   // 红：高相似
  if (v >= 40) return '#fa8c16'   // 橙
  if (v >= 20) return '#faad14'   // 黄
  if (v > 0) return '#52c41a'     // 绿：有值
  return '#bfbfbf'                // 灰：零
}

// hash 风格文件名兜底 — 用户上传的有时是浏览器 cache 路径名 / 随机 hash 名
// 与 mp-weixin pages/report/index.js 内同款 helper 必须保持判定逻辑完全一致
function prettifyFileName(name: string, fallback = '对比文档'): string {
  if (!name) return fallback
  const stem = name.replace(/\.[^.]+$/, '')
  // hash 特征：纯字母数字 + 长度 ≥ 20
  if (/^[A-Za-z0-9]{20,}$/.test(stem)) return fallback
  return name
}

// 1对1 模式下把 documentName 从 "A.pdf vs B.pdf" 改成「主文档 与 对比文档」自然表达
function naturalDocName(documentName: string, isPair: boolean): string {
  if (!documentName) return '未命名文档'
  if (!isPair) return documentName
  if (documentName.includes(' vs ')) {
    const [a, b] = documentName.split(' vs ')
    return `1对1 比对：${prettifyFileName(a, '主文档')} 与 ${prettifyFileName(b, '对比文档')}`
  }
  return documentName
}

export default function CompareReportPage() {
  const { taskNo } = useParams<{ taskNo: string }>()
  const nav = useNavigate()
  const { isPaid } = useAccess()
  const [loading, setLoading] = useState(true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null)
  const [unlocking, setUnlocking] = useState(false)
  const [exporting, setExporting] = useState(false)
  const reportRef = useRef<HTMLDivElement>(null)

  const load = async () => {
    if (!taskNo) return
    setLoading(true)
    try {
      setData(await getCompareTask(taskNo))
    } catch {
      setData(null)
    }
    setLoading(false)
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [taskNo])

  const proceedUnlock = async () => {
    setUnlocking(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await unlockCompareReport(taskNo!)
      if (res?.memberFree) {
        message.success('会员权益：报告已解锁')
        load()
      } else {
        message.success('订单已创建，请前往订单页面完成支付')
        nav('/orders')
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '创建订单失败')
    }
    setUnlocking(false)
  }

  const handleUnlock = async () => {
    if (!taskNo) return
    // 功能 b：低质量报告付费前警告
    const maxSim = preview?.summaryOverallMax ?? 100
    const matchCount = preview?.topSimilarCount ?? 99
    const isLowQuality = (maxSim < 15 && matchCount < 3) || matchCount === 0
    if (isLowQuality) {
      Modal.confirm({
        title: '报告质量提示',
        icon: <ExclamationCircleOutlined />,
        content: (
          <div>
            <p>本次比对结果相似度较低（最高 {maxSim.toFixed(1)}%），报告的参考价值可能有限。</p>
            <p style={{ color: '#fa8c16' }}>建议：先检查上传文档是否正确，或选择质量更好的文档重新比对，避免不必要的付费。</p>
          </div>
        ),
        okText: '仍然解锁',
        cancelText: '暂不解锁',
        onOk: () => proceedUnlock(),
      })
      return
    }
    proceedUnlock()
  }

  const handleExportPdf = useCallback(async () => {
    if (!reportRef.current) return
    setExporting(true)
    try {
      const el = reportRef.current
      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        logging: false,
        backgroundColor: '#ffffff',
        windowWidth: 1200,
      })
      const imgData = canvas.toDataURL('image/jpeg', 0.92)
      const pdf = new jsPDF('p', 'mm', 'a4')
      const pageWidth = pdf.internal.pageSize.getWidth()
      const pageHeight = pdf.internal.pageSize.getHeight()
      const margin = 10
      const contentWidth = pageWidth - margin * 2
      const imgHeight = (canvas.height * contentWidth) / canvas.width
      let yOffset = 0
      let page = 0
      while (yOffset < imgHeight) {
        if (page > 0) pdf.addPage()
        pdf.addImage(imgData, 'JPEG', margin, margin - yOffset, contentWidth, imgHeight)
        yOffset += pageHeight - margin * 2
        page++
      }
      const fileName = `标准比对报告_${taskNo}_${new Date().toISOString().slice(0, 10)}.pdf`
      pdf.save(fileName)
      message.success('PDF 导出成功')
    } catch (err) {
      console.error('[pdf-export]', err)
      message.error('PDF 导出失败，请重试')
    }
    setExporting(false)
  }, [taskNo])

  if (loading) {
    return <Card style={{ textAlign: 'center', padding: 80 }}><Spin size="large" tip="加载报告中..." /></Card>
  }
  if (!data) {
    return <Card><Empty description="报告不存在或已失效"><Button type="primary" onClick={() => nav('/compare')}>返回比对列表</Button></Empty></Card>
  }

  const { freeRisk: rawFreeRisk = [], access, report, status, documentName, compareMode, preview, riskLevel, riskLabel } = data
  // 章节跳号已对外隐藏（误报率高），filter freeRisk 中含"跳号"的字符串
  const freeRisk = (rawFreeRisk as string[]).filter((r: string) => !r.includes('跳号'))
  const isUnlocked = access?.fullReportUnlocked
  const isLibrary = compareMode === 'library'

  return (
    <div>
      {/* 顶部 */}
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => nav('/compare')}>返回列表</Button>
        <Button icon={<ReloadOutlined />} onClick={load}>刷新</Button>
        {isLibrary && isUnlocked && report && (
          <Button type="primary" icon={<FilePdfOutlined />} loading={exporting} onClick={handleExportPdf}>
            导出 PDF
          </Button>
        )}
      </Space>

      {/* 报告头部 */}
      <Card style={{ marginBottom: 16 }}>
        <Row gutter={24} align="middle">
          <Col flex="auto">
            <Title level={4} style={{ margin: 0, marginBottom: 8 }}>{naturalDocName(documentName, !isLibrary)}</Title>
            <Space>
              <Tag>任务编号：{taskNo}</Tag>
              <Tag color={isLibrary ? 'purple' : 'blue'}>
                {isLibrary ? '全库相似度分析' : '1对1比对'}
              </Tag>
              <Tag color={status === 'COMPLETED' ? 'green' : status === 'FAILED' ? 'red' : 'blue'}>
                {status === 'COMPLETED' ? '已完成' : status === 'FAILED' ? '失败' : '处理中'}
              </Tag>
              {riskLevel && (
                <Tag color={riskColor(riskLevel)} icon={<SafetyCertificateOutlined />}>
                  {riskLabel}
                </Tag>
              )}
            </Space>
          </Col>
        </Row>
      </Card>

      {/* 未完成 */}
      {status === 'FAILED' && (
        <Card>
          <Result
            status="error"
            title="比对任务失败"
            subTitle="服务处理异常，可能是文档格式不支持或服务暂时繁忙。可重试或重新发起比对。"
            extra={
              <Space>
                <Button type="primary" icon={<ReloadOutlined />} onClick={async () => {
                  try {
                    await retryCompareTask(taskNo!)
                    message.success('已重新提交')
                    load()
                  } catch { message.error('重试失败') }
                }}>重试</Button>
                <Button onClick={() => nav('/compare')}>重新发起比对</Button>
              </Space>
            }
          />
        </Card>
      )}
      {status !== 'COMPLETED' && status !== 'FAILED' && (
        <Card>
          <Result
            icon={<Spin size="large" />}
            title="任务处理中"
            subTitle="全库相似度分析需要一定时间，请稍后刷新查看结果"
            extra={<Button icon={<ReloadOutlined />} onClick={load}>刷新状态</Button>}
          />
        </Card>
      )}

      {/* 安全截断提示（1v1 文本超 6 万字时 worker 截断后比对，需明示用户） */}
      {status === 'COMPLETED' && report?.truncationNote && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="本次比对内容已截断"
          description={report.truncationNote}
        />
      )}

      {/* 风险摘要（免费可见） */}
      {status === 'COMPLETED' && freeRisk.length > 0 && (
        <Alert
          type={riskLevel === 'high' ? 'error' : riskLevel === 'medium' ? 'warning' : 'success'}
          icon={riskLevel === 'low' ? <CheckCircleOutlined /> : <WarningOutlined />}
          showIcon
          style={{ marginBottom: 16 }}
          message="风险摘要（免费可见）"
          description={
            <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
              {freeRisk.map((r: string, i: number) => <li key={i}>{r}</li>)}
            </ul>
          }
        />
      )}

      {/* ═══ 全库相似度分析 — 免费预览层 ═══ */}
      {status === 'COMPLETED' && isLibrary && preview && !isUnlocked && (
        <LibraryPreview preview={preview} />
      )}

      {/* ═══ 全库相似度分析 — 完整报告（解锁后） ═══ */}
      {status === 'COMPLETED' && isLibrary && isUnlocked && report && (
        <div ref={reportRef}>
          <LibraryFullReport report={report} />
        </div>
      )}

      {/* ═══ 1v1 比对报告 ═══ */}
      {status === 'COMPLETED' && !isLibrary && report && (
        <PairReport report={report} documentName={documentName} />
      )}

      {/* R03 站内弹窗：免费用户 + 库比对 + 完成 + 未解锁 → 底部浮层引导升级 */}
      {status === 'COMPLETED' && isLibrary && !isUnlocked && !isPaid && taskNo && (
        <CompareUpgradePrompt taskNo={taskNo} />
      )}

      {/* 解锁按钮（仅全库相似度分析需要，一对一全员免费直接可看） */}
      {status === 'COMPLETED' && isLibrary && !isUnlocked && (
        <Card style={{ textAlign: 'center', padding: '32px 0', marginTop: 16 }}>
          {/* 功能 b：低质量视觉提示 */}
          {isLibrary && preview && ((preview.summaryOverallMax ?? 100) < 15 || preview.topSimilarCount === 0) && (
            <Alert
              type="warning"
              showIcon
              icon={<ExclamationCircleOutlined />}
              message="该报告匹配度较低，解锁前请确认文档内容是否正确"
              style={{ marginBottom: 20, textAlign: 'left' }}
            />
          )}
          <LockOutlined style={{ fontSize: 48, color: '#bfbfbf', marginBottom: 16 }} />
          <Title level={5} style={{ marginBottom: 8 }}>查看完整分析报告</Title>
          <Paragraph type="secondary" style={{ marginBottom: 20 }}>
            {isLibrary
              ? '解锁后可查看全部相似标准详细分析、引用风险逐条诊断、术语匹配详情、结构完整性检测等'
              : '包含逐章节详细比对结果、相似度评分、差异分析及分析参考'}
          </Paragraph>
          <Button type="primary" size="large" icon={<UnlockOutlined />} loading={unlocking} onClick={handleUnlock}>
            解锁分析报告（会员权益）
          </Button>
        </Card>
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

// ─── 全库相似度分析免费预览 ──────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function LibraryPreview({ preview }: { preview: any }) {
  const overallPct = (preview.summaryOverallMax || 0).toFixed(1)
  const overallNum = parseFloat(overallPct)

  // 功能 a：无匹配或极低相似度 → 友好提示
  if (preview.topSimilarCount === 0 && overallNum < 5) {
    return (
      <Card style={{ marginBottom: 16 }}>
        <Result
          icon={<InfoCircleOutlined style={{ color: '#1677ff' }} />}
          title="未找到高相似度标准"
          subTitle="您上传的文档与库中现有标准差异较大，暂未检测到显著的内容重叠。这可能是因为文档内容较为独特，或不属于当前标准库的覆盖范围。"
          extra={
            <Space>
              <Button type="primary" onClick={() => window.history.back()}>重新选择文档</Button>
              <Button onClick={() => window.location.reload()}>刷新重试</Button>
            </Space>
          }
        />
        <Alert
          type="info"
          showIcon
          message="建议"
          description={
            <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
              <li>确认上传的文档是否为标准文本（非扫描件、非纯图片 PDF）</li>
              <li>检查文档内容是否完整（文本长度是否充足）</li>
              <li>尝试上传不同版本或相关领域的标准文档</li>
            </ul>
          }
          style={{ marginTop: 16 }}
        />
      </Card>
    )
  }

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* 低质量警告横幅 */}
      {overallNum < 15 && preview.topSimilarCount > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          message="报告相似度较低"
          description="本次比对结果中相似标准的匹配度均较低，报告参考价值有限。建议确认上传文档是否正确，或尝试其他文档。"
          style={{ marginBottom: 0 }}
        />
      )}
      {/* 指标总览 */}
      <Card title="评估总览">
        <Row gutter={24}>
          <Col span={6}>
            <Statistic
              title="最高综合相似度"
              value={overallPct}
              suffix="%"
              valueStyle={{ color: overallNum >= 40 ? '#f5222d' : overallNum >= 20 ? '#fa8c16' : '#52c41a' }}
            />
          </Col>
          <Col span={6}>
            <Statistic
              title="引用规范性问题"
              value={preview.referencesIssueCount ?? 0}
              suffix="项"
              valueStyle={{ color: preview.referencesIssueCount > 0 ? '#fa8c16' : '#52c41a' }}
            />
          </Col>
          <Col span={6}>
            <Statistic title="术语匹配" value={preview.termsMatched ?? 0} suffix="项" />
          </Col>
          <Col span={6}>
            <Statistic
              title="内容重复率"
              value={preview.duplicationRate ?? 0}
              suffix="%"
              valueStyle={{ color: (preview.duplicationRate || 0) > 30 ? '#f5222d' : '#52c41a' }}
            />
          </Col>
        </Row>
      </Card>

      {/* Top 3 相似标准 */}
      {preview.topSimilarPreview?.length > 0 && (
        <Card title={`高相似度标准（前 ${preview.topSimilarPreview.length} 条）`}>
          <Table scroll={{ x: "max-content" }}
            rowKey="code"
            dataSource={preview.topSimilarPreview}
            pagination={false}
            size="small"
            columns={[
              { title: '标准编号', dataIndex: 'code', width: 200 },
              { title: '标准名称', dataIndex: 'name', ellipsis: true },
              {
                title: '综合相似度', dataIndex: 'overall_score', width: 120,
                render: (v: number) => (
                  // overall_score 统一百分比数值（如 45.2 表示 45.2%），直接用
                  <Tag color={v >= 40 ? 'red' : v >= 20 ? 'orange' : 'green'}>{v.toFixed(1)}%</Tag>
                ),
              },
            ]}
          />
          {preview.topSimilarCount > 3 && (
            <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 8 }}>
              还有 {preview.topSimilarCount - 3} 条相似标准，解锁后查看完整分析
            </Text>
          )}
        </Card>
      )}

      {/* 初步分析 */}
      {(() => {
        // 章节跳号已对外隐藏，filter conclusions 中含"跳号"的字符串
        const filteredConclusions = (preview.conclusions || []).filter((c: string) => !c.includes('跳号'))
        if (filteredConclusions.length === 0) return null
        return (
          <Card title="初步分析">
            {filteredConclusions.map((c: string, i: number) => (
              <Alert key={i} message={c} type={conclusionAlertType(c)} showIcon style={{ marginBottom: 8 }} />
            ))}
          </Card>
        )
      })()}
    </Space>
  )
}

// ─── 全库相似度分析完整报告 ──────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function LibraryFullReport({ report }: { report: any }) {
  const isMobile = useIsMobile()
  const summary = report.summary || {}
  const overallPct = (summary.overall_max || 0).toFixed(1)
  const dims = summary.dimensions || {}

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* 评估总览 */}
      <Card
        title={<><SafetyCertificateOutlined /> 评估总览</>}
        extra={<Tag color="green"><UnlockOutlined /> 已解锁</Tag>}
      >
        <Row gutter={24}>
          <Col span={4}>
            <Statistic title="最高综合相似度" value={overallPct} suffix="%" valueStyle={{ color: simColor(parseFloat(overallPct)) }} />
          </Col>
          <Col span={4}>
            <Statistic title="题名相似度" value={(dims.title || 0).toFixed(1)} suffix="%" valueStyle={{ color: simColor(dims.title || 0) }} />
          </Col>
          <Col span={4}>
            <Statistic title="内容相似度" value={(dims.content || 0).toFixed(1)} suffix="%" valueStyle={{ color: simColor(dims.content || 0) }} />
          </Col>
          <Col span={4}>
            <Statistic title="结构相似度" value={(dims.structure || 0).toFixed(1)} suffix="%" valueStyle={{ color: simColor(dims.structure || 0) }} />
          </Col>
          <Col span={4}>
            <Statistic title="引用重叠度" value={(dims.reference || 0).toFixed(1)} suffix="%" valueStyle={{ color: simColor(dims.reference || 0) }} />
          </Col>
          <Col span={4}>
            <Statistic title="术语重叠度" value={(dims.term || 0).toFixed(1)} suffix="%" valueStyle={{ color: simColor(dims.term || 0) }} />
          </Col>
        </Row>
      </Card>

      {/* 高相似度标准（带进度条） */}
      {report.top_similar?.length > 0 && (
        <Card title={`高相似度标准（${report.top_similar.length} 条）`}>
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {report.top_similar.map((s: any, i: number) => (
            <div key={s.code || i} style={{
              padding: '14px 16px', marginBottom: 10, borderRadius: 10,
              background: i % 2 === 0 ? '#fafbfd' : '#fff',
              border: '1px solid #f0f0f0',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <Text strong style={{ color: '#1677ff', fontSize: 14 }}>{s.code}</Text>
                  <Text style={{ marginLeft: 8, fontSize: 13 }}>{s.name}</Text>
                </div>
                <Tag color={s.overall_score >= 40 ? 'red' : s.overall_score >= 20 ? 'orange' : 'green'} style={{ fontSize: 14, fontWeight: 700 }}>
                  {s.overall_score}%
                </Tag>
              </div>
              <Progress
                percent={s.overall_score}
                strokeColor={s.overall_score >= 40 ? '#f5222d' : s.overall_score >= 20 ? '#fa8c16' : '#52c41a'}
                showInfo={false}
                size="small"
                style={{ marginBottom: 8 }}
              />
              {!isMobile && (
                <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#8c8c8c' }}>
                  <span>题名 <Text strong>{s.title_sim}%</Text></span>
                  <span>内容 <Text strong style={{ color: simColor(s.content_sim) }}>{s.content_sim}%</Text></span>
                  <span>结构 <Text strong>{s.structure_sim}%</Text></span>
                  <span>引用 <Text strong>{s.reference_sim}%</Text></span>
                  {s.status && (
                    <span>
                      {s.status === '现行' ? <Tag color="green" style={{ fontSize: 11 }}>现行</Tag>
                        : s.status === '废止' || s.status === '作废' ? <Tag color="red" style={{ fontSize: 11 }}>已废止</Tag>
                        : <Tag style={{ fontSize: 11 }}>{s.status}</Tag>}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
          {/* 保留表格供需要排序的场景 */}
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', color: '#8c8c8c', fontSize: 12 }}>展开表格视图</summary>
          <Table scroll={{ x: "max-content" }}
            rowKey="code"
            dataSource={report.top_similar}
            pagination={false}
            size="small"
            style={{ marginTop: 8 }}
            columns={[
              { title: '标准编号', dataIndex: 'code', width: isMobile ? 120 : 180 },
              { title: '标准名称', dataIndex: 'name', ellipsis: true },
              {
                title: '综合', dataIndex: 'overall_score', width: 80, align: 'center' as const,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                sorter: (a: any, b: any) => a.overall_score - b.overall_score,
                render: (v: number) => <Tag color={v >= 40 ? 'red' : v >= 20 ? 'orange' : 'green'}>{v}%</Tag>,
              },
              {
                title: '题名', dataIndex: 'title_sim', width: 70, align: 'center' as const, hidden: isMobile,
                render: (v: number) => `${v}%`,
              },
              {
                title: '内容', dataIndex: 'content_sim', width: 70, align: 'center' as const, hidden: isMobile,
                render: (v: number) => <Text style={{ color: simColor(v) }}>{v}%</Text>,
              },
              {
                title: '结构', dataIndex: 'structure_sim', width: 70, align: 'center' as const, hidden: isMobile,
                render: (v: number) => `${v}%`,
              },
              {
                title: '引用', dataIndex: 'reference_sim', width: 70, align: 'center' as const, hidden: isMobile,
                render: (v: number) => `${v}%`,
              },
              {
                title: '有效性', dataIndex: 'status', width: 90, hidden: isMobile,
                render: (v: string) => {
                  if (v === '现行') return <Tag color="green">现行</Tag>
                  if (v === '作废' || v === '废止') return <Tag color="red">已废止</Tag>
                  if (v === '即将实施') return <Tag color="blue">即将实施</Tag>
                  return <Tag color="default">-</Tag>
                },
              },
              {
                title: '发布/实施', width: 150, hidden: isMobile,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render: (_: any, r: any) => {
                  const pub = r.pub_date ? r.pub_date.slice(0, 10) : ''
                  const impl = r.impl_date ? r.impl_date.slice(0, 10) : ''
                  if (!pub && !impl) return <Text type="secondary" style={{ fontSize: 12 }}>-</Text>
                  return (
                    <div style={{ lineHeight: '1.5', fontSize: 12 }}>
                      {pub && <div>发布 {pub}</div>}
                      {impl && <div style={{ color: '#8c8c8c' }}>实施 {impl}</div>}
                    </div>
                  )
                },
              },
              {
                title: '发布机构', dataIndex: 'issuing_dept', width: 140, ellipsis: true, hidden: isMobile,
                render: (v: string) => v
                  ? <Tooltip title={v}><Text style={{ fontSize: 12 }}>{v}</Text></Tooltip>
                  : <Text type="secondary" style={{ fontSize: 12 }}>-</Text>,
              },
              {
                title: '命中章节', width: 180, ellipsis: true, hidden: isMobile,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                render: (_: any, r: any) => {
                  const secs = r.matched_sections || []
                  if (secs.length === 0) return <Text type="secondary">-</Text>
                  return (
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    <Tooltip title={secs.map((s: any) => `${s.user_section} ↔ ${s.lib_section} (${Math.round(s.similarity * 100)}%)`).join('\n')}>
                      <Text>{secs.length} 个匹配章节</Text>
                    </Tooltip>
                  )
                },
              },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ].filter(c => !('hidden' in c && (c as any).hidden))}
          />
          </details>
        </Card>
      )}

      {/* 引用文件规范性 */}
      {report.references && (
        <Card title="引用文件规范性">
          <Text>共检测到 {report.references.total} 条引用标准，{report.references.valid} 条有效</Text>
          {report.references.issues?.length > 0 ? (
            <Table scroll={{ x: "max-content" }}
              rowKey="cited_code"
              dataSource={report.references.issues}
              pagination={false}
              size="small"
              style={{ marginTop: 12 }}
              columns={[
                { title: '引用标准', dataIndex: 'cited_code', width: isMobile ? 120 : 200 },
                // 「来源 / 元数据 / 主库」列已删除:暴露内部数据源结构,
                // 不符合合规要求(不向用户展示数据源构成)
                {
                  title: '状态', dataIndex: 'status', width: 100,
                  render: (v: string) => {
                    if (v === '已废止') return <Tag color="red">已废止</Tag>
                    if (v === '即将废止') return <Tag color="orange">即将废止</Tag>
                    if (v === '版本较旧') return <Tag color="gold">版本较旧</Tag>
                    return <Tag color="orange">{v}</Tag>
                  },
                },
                { title: '问题描述', dataIndex: 'issue', ellipsis: true },
                { title: '处理建议', dataIndex: 'replacement', ellipsis: true, hidden: isMobile },
              ].filter(c => !('hidden' in c && c.hidden))}
            />
          ) : (
            <Alert type="success" message="所有引用标准版本均在合理范围内" style={{ marginTop: 12 }} />
          )}
        </Card>
      )}

      {/* 术语匹配 */}
      {report.terms?.details?.length > 0 && (
        <Card title={`术语匹配（${report.terms.matched} 项）`}>
          <Table scroll={{ x: "max-content" }}
            rowKey="term"
            dataSource={report.terms.details}
            pagination={false}
            size="small"
            columns={[
              { title: '术语', dataIndex: 'term', width: 200 },
              {
                title: '匹配标准', dataIndex: 'matched_in',
                render: (v: string[]) => (v || []).join('、'),
              },
            ]}
          />
        </Card>
      )}

      {/* 结构完整性（GB/T 1.1-2020 口径） */}
      {report.structure && (
        <Card
          title="结构完整性"
          extra={
            report.structure.complete
              ? <Tag color="green">符合规范</Tag>
              : <Tag color="orange">需修正</Tag>
          }
        >
          {/* 必备章节 */}
          <Text>必备章节覆盖 {report.structure.required_found}/{report.structure.required_total} 项</Text>
          {report.structure.missing?.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`缺少必备章节：${report.structure.missing.join('、')}`}
              style={{ marginTop: 8 }}
            />
          ) : (
            <Alert type="success" showIcon message="必备章节完整" style={{ marginTop: 8 }} />
          )}

          {/* 章节跳号 — 已对外隐藏：不同标准/草稿章节编号写法差异太大，
              连续性判定误报率高，对用户来说价值低、噪音大。
              后端 dedup report.py 仍在产出 structure.gap_issues 字段供内部使用，
              但前端不再展示。conclusions / freeRisk 中的"跳号"字符串
              在数据接收层 filter 掉。 */}

          {/* 深度超限 */}
          {report.structure.depth_issues?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text strong style={{ color: '#fa8c16' }}>章节深度超 4 级（GB/T 1.1-2020 §9.3）</Text>
              <Table scroll={{ x: "max-content" }}
                rowKey="section"
                dataSource={report.structure.depth_issues}
                pagination={false}
                size="small"
                style={{ marginTop: 8 }}
                columns={[
                  { title: '章节号', dataIndex: 'section', width: 120 },
                  { title: '标题', dataIndex: 'title', ellipsis: true },
                  {
                    title: '深度', dataIndex: 'depth', width: 80, align: 'center' as const,
                    render: (v: number) => <Tag color="orange">{v} 级</Tag>,
                  },
                ]}
              />
            </div>
          )}

          {/* 列项层级（§7.5.2）*/}
          {report.structure.list_nesting_issues?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text strong style={{ color: '#fa8c16' }}>列项嵌套超限（GB/T 1.1-2020 §7.5.2）</Text>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {report.structure.list_nesting_issues.map((item: any, i: number) => (
                <Alert key={i} type="warning" showIcon message={item.issue} description={item.suggestion} style={{ marginTop: 8 }} />
              ))}
            </div>
          )}

          {/* 附录规范性标注（§9.6.2）*/}
          {report.structure.appendix_issues?.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <Text strong style={{ color: '#fa8c16' }}>附录标注缺失（GB/T 1.1-2020 §9.6.2）</Text>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {report.structure.appendix_issues.map((item: any, i: number) => (
                <Alert key={i} type="warning" showIcon message={item.issue} description={item.suggestion} style={{ marginTop: 8 }} />
              ))}
            </div>
          )}

          {/* 全部通过 */}
          {report.structure.complete && (
            <Alert type="success" showIcon message="章节编号规范，结构完整" style={{ marginTop: 8 }} />
          )}
        </Card>
      )}

      {/* 内部章节引用检查（悬置段检测）*/}
      {report.dangling_sections && report.dangling_sections.checked > 0 && (
        <Card title="内部章节引用检查">
          <Text>
            共扫描到 {report.dangling_sections.checked} 处内部章节引用，其中{' '}
            <Text strong style={{ color: report.dangling_sections.dangling_count > 0 ? '#f5222d' : '#52c41a' }}>
              {report.dangling_sections.dangling_count} 处
            </Text>
            {' '}指向不存在的章节。
          </Text>
          {report.dangling_sections.dangling?.length > 0 ? (
            <Table scroll={{ x: "max-content" }}
              rowKey="target"
              dataSource={report.dangling_sections.dangling}
              pagination={false}
              size="small"
              style={{ marginTop: 12 }}
              columns={[
                { title: '引用描述', dataIndex: 'ref', width: 200 },
                { title: '目标章节号', dataIndex: 'target', width: 120 },
                { title: '所在章节', dataIndex: 'in_section', ellipsis: true },
              ]}
            />
          ) : (
            <Alert type="success" message="所有内部章节引用均可在文档中找到对应章节" style={{ marginTop: 12 }} />
          )}
        </Card>
      )}

      {/* 行业格局分析（元数据联动，参考统计）*/}
      {report.industry_landscape?.available && (
        <Card
          title={
            <>
              行业标准格局
              <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                ICS {report.industry_landscape.ics_prefix}
                {report.industry_landscape.ics_name ? ` · ${report.industry_landscape.ics_name}` : ''}
                （参考统计）
              </Text>
            </>
          }
        >
          <Row gutter={24}>
            <Col span={8}>
              <Statistic title="现行标准" value={report.industry_landscape.active_count} suffix="条"
                valueStyle={{ color: '#1677ff' }} />
            </Col>
            <Col span={8}>
              <Statistic title="已废止" value={report.industry_landscape.obsolete_count} suffix="条"
                valueStyle={{ color: '#bfbfbf' }} />
            </Col>
            <Col span={8}>
              <Statistic title="即将实施" value={report.industry_landscape.upcoming_count} suffix="条"
                valueStyle={{ color: '#52c41a' }} />
            </Col>
          </Row>
          <Text type="secondary" style={{ display: 'block', marginTop: 12, fontSize: 12 }}>
            {report.industry_landscape.insight}
          </Text>
        </Card>
      )}

      {/* 内容重复率 */}
      {report.duplication && (
        <Card title="内容重复率">
          <Row gutter={24}>
            <Col span={8}>
              <Progress
                type="dashboard"
                percent={report.duplication.estimated_rate || 0}
                format={(pct) => `${pct}%`}
                strokeColor={report.duplication.estimated_rate > 30 ? '#f5222d' : '#52c41a'}
                size={120}
              />
              <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 8 }}>估算整体内容重复率</Text>
            </Col>
            <Col span={16}>
              <Row gutter={[16, 16]}>
                <Col span={8}><Statistic title="高相似（>30%）" value={report.duplication.high_sim_count} suffix="条" valueStyle={{ color: '#f5222d' }} /></Col>
                <Col span={8}><Statistic title="中相似（15-30%）" value={report.duplication.medium_sim_count} suffix="条" valueStyle={{ color: '#fa8c16' }} /></Col>
                <Col span={8}><Statistic title="低相似（5-15%）" value={report.duplication.low_sim_count} suffix="条" valueStyle={{ color: '#52c41a' }} /></Col>
              </Row>
            </Col>
          </Row>
        </Card>
      )}

      {/* 综合分析（颜色区分） — 章节跳号 filter 已对外隐藏 */}
      {(() => {
        const filteredConclusions = (report.conclusions || []).filter((c: string) => !c.includes('跳号'))
        return filteredConclusions.length > 0 && (
        <Card title="综合分析">
          {filteredConclusions.map((c: string, i: number) => {
            const severity = conclusionAlertType(c)
            return (
              <Alert
                key={i}
                message={c}
                type={severity}
                showIcon
                style={{
                  marginBottom: 8,
                  borderRadius: 8,
                  borderLeft: `4px solid ${severity === 'warning' ? '#fa8c16' : severity === 'success' ? '#52c41a' : '#1677ff'}`,
                }}
              />
            )
          })}
        </Card>
        )
      })()}

      {/* 免责声明 */}
      <Card style={{ background: '#fafafa', borderColor: '#e8e8e8' }}>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text style={{ fontSize: 13, fontWeight: 600, color: '#595959' }}>免责声明</Text>
          <Text style={{ fontSize: 12, color: '#8c8c8c', lineHeight: '1.8', display: 'block' }}>
            本报告由标准小智 AI 自动生成，基于用户上传内容、公开标准题录信息及自研规则模型输出，仅供检索、研判与写作参考，不构成标准现行有效性、合规性或立项可行性的最终认定；涉及标准状态、替代关系、适用性及相关内容权属的，具体以权威公告、相关标准发布机构及版权权利人的官方信息为准。
          </Text>
        </Space>
      </Card>
    </Space>
  )
}

// ─── 1v1 比对报告 ──────────────────────────────────────────

/** 结论文案 → 严重程度颜色 */
function conclusionSeverity(text: string): 'error' | 'warning' | 'success' | 'info' {
  if (/缺失|问题|不符|缺少|错误|违反|风险|修订/.test(text)) return 'error'
  if (/建议|注意|补充|完善|待/.test(text)) return 'warning'
  if (/良好|正常|符合|通过|完整/.test(text)) return 'success'
  return 'info'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function PairReport({ report, documentName }: { report: any; documentName: string }) {
  const rawNames = (documentName || '').split(' vs ')
  // 截断过长文件名 + hash 兜底（避免直接展示浏览器随机文件名）
  const shorten = (n: string, fallback: string) => {
    const safe = prettifyFileName(n, fallback)
    const name = safe.replace(/\.[^.]+$/, '').replace(/[+_]/g, ' ').trim()
    return name.length > 20 ? name.slice(0, 20) + '...' : name
  }
  const nameA = shorten(rawNames[0] || '', '主文档')
  const nameB = shorten(rawNames[1] || '', '对比文档')

  // 提取映射数据
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mappings: any[] = []
  if (report.mappings) {
    mappings = report.mappings
  } else if (report.similarStandards?.[0]?.sectionPairs) {
    // 后端 compare-engine 写入的 similarity 已经是整数百分比 (0-100)，不要再 *100
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mappings = report.similarStandards[0].sectionPairs.map((p: any) => ({
      sectionA: p.sourceSection || '', sectionB: p.targetSection || '',
      contentA: p.sourceContent || '', contentB: p.targetContent || '',
      similarity: Math.round(p.similarity || 0),
    }))
  } else if (report.duplicateParagraphs?.length) {
    // duplicateParagraphs.similarity 由 compare-engine.ts:285 `Math.round(maxSim * 100)` 写入，
    // 已经是整数百分比 (0-100)。原代码再 *100 导致显示成 3600%，bug 已修。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mappings = report.duplicateParagraphs.map((d: any) => {
      const parts = (d.section || '').split(' ↔ ')
      return { sectionA: parts[0] || '', sectionB: parts[1] || '', contentA: '', contentB: '', similarity: Math.round(d.similarity || 0) }
    })
  }

  // 总体相似度永远展示,即使没有匹配段落也要让用户看到核心数字
  // 优先用后端 similarStandards[0].overallSimilarity (B1 fix 后这里就是 USER_B 真比对结果),
  // fallback 到段落均值
  const overallSim = report.similarStandards?.[0]?.overallSimilarity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ?? (mappings.length ? Math.round(mappings.reduce((s: number, m: any) => s + m.similarity, 0) / mappings.length) : 0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const highSimCount = mappings.filter((m: any) => m.similarity >= 60).length

  return (
    <Space direction="vertical" style={{ width: '100%' }} size="middle">
      {/* 报告标题 */}
      <Card style={{ background: 'linear-gradient(135deg, #f0f5ff 0%, #e8f4fd 100%)', border: 'none' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 15, color: '#1a2236', fontWeight: 600, marginBottom: 4 }}>{nameA}</div>
          <div style={{ fontSize: 12, color: '#999', margin: '4px 0' }}>对比</div>
          <div style={{ fontSize: 15, color: '#1a2236', fontWeight: 600 }}>{nameB}</div>
        </div>
      </Card>

      {/* 指标总览 — 始终展示,即使没有相似段落也要让用户看到总体相似度 */}
      <Card>
        <Row gutter={24}>
          <Col span={8}>
            <Statistic
              title="总体相似度"
              value={overallSim}
              suffix="%"
              valueStyle={{ color: simColor(overallSim) }}
            />
          </Col>
          <Col span={8}>
            <Statistic title="相似段落对" value={mappings.length} suffix="对" />
          </Col>
          <Col span={8}>
            <Statistic
              title="高相似 (≥60%)"
              value={highSimCount}
              valueStyle={{ color: highSimCount > 0 ? '#f5222d' : '#52c41a' }}
            />
          </Col>
        </Row>
      </Card>

      {/* 总览指标（来自后端 summaryMetrics，跟小程序 PairReport 对齐）*/}
      {report.summaryMetrics?.length > 0 && (
        <Card title="总览指标">
          <Row gutter={[16, 16]}>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {report.summaryMetrics.map((m: any, i: number) => (
              <Col xs={24} sm={8} key={i}>
                <div style={{
                  padding: '14px 16px',
                  borderRadius: 10,
                  background: '#fafbfd',
                  border: '1px solid #f0f0f0',
                  textAlign: 'center',
                }}>
                  <div style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: m.accent === 'red' ? '#f5222d'
                      : m.accent === 'orange' ? '#fa8c16'
                      : m.accent === 'green' ? '#52c41a'
                      : '#1677ff',
                    marginBottom: 4,
                  }}>{m.value}</div>
                  <div style={{ fontSize: 13, color: '#1a2236', fontWeight: 600, marginBottom: 4 }}>{m.label}</div>
                  <div style={{ fontSize: 11, color: '#8c8c8c' }}>{m.detail}</div>
                </div>
              </Col>
            ))}
          </Row>
        </Card>
      )}

      {/* 文件对比摘要（1对1） */}
      {report.similarStandards?.length > 0 && (() => {
        const s0 = report.similarStandards[0]
        const parts = (documentName || '').split(' vs ')
        const fileAName = prettifyFileName(parts[0], '主文档')
        const fileBName = prettifyFileName(parts[1], '对比文档')
        return (
        <Card title="文件对比摘要">
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 13, color: '#304255', lineHeight: 1.8 }}>文件 A：{fileAName}</div>
            <div style={{ fontSize: 13, color: '#304255', lineHeight: 1.8 }}>文件 B：{fileBName}</div>
          </div>
          <div style={{ borderTop: '1px solid #f0f0f0', paddingTop: 12 }}>
            {[
              { label: '综合相似度', value: s0.overallSimilarity, color: simColor(s0.overallSimilarity) },
              { label: '标题相似度', value: s0.titleSimilarity },
              { label: '范围相似度', value: s0.scopeSimilarity },
              { label: '正文相似度', value: s0.textSimilarity },
            ].map(d => (
              <div key={d.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 13 }}>
                <span style={{ color: '#677586' }}>{d.label}</span>
                <Text strong style={{ color: d.color || '#304255' }}>{d.value}%</Text>
              </div>
            ))}
          </div>
        </Card>
        )
      })()}

      {/* 无相似段落时的友好空状态(只在真无段落配对且总体相似度极低时显示) */}
      {mappings.length === 0 && overallSim < 5 && (
        <Card>
          <Result
            icon={<CheckCircleOutlined style={{ color: '#52c41a' }} />}
            title="未检测到显著相似段落"
            subTitle="两份文档相似度极低,可视为不相关文档。"
          />
        </Card>
      )}

      {/* 章节映射卡片（带进度条） */}
      {mappings.length > 0 && (
        <Card title="章节比对结果">
          {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
          {mappings.map((m: any, i: number) => (
            <div key={i} style={{
              padding: '14px 16px', marginBottom: 10, borderRadius: 10,
              background: i % 2 === 0 ? '#fafbfd' : '#fff',
              border: '1px solid #f0f0f0',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <div style={{ flex: 1, borderLeft: '3px solid #1677ff', paddingLeft: 10 }}>
                <Text strong style={{ fontSize: 13 }}>{m.sectionA || `章节 ${i + 1}`}</Text>
                {m.contentA && <div style={{ fontSize: 12, color: '#888', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>{m.contentA}</div>}
              </div>
              <div style={{ textAlign: 'center', minWidth: 70 }}>
                <Tag color={m.similarity >= 60 ? 'red' : m.similarity >= 40 ? 'orange' : 'green'} style={{ fontSize: 13, fontWeight: 700 }}>
                  {m.similarity}%
                </Tag>
                <div style={{ fontSize: 18, color: '#c0c8d4' }}>⟷</div>
              </div>
              <div style={{ flex: 1, borderRight: '3px solid #ff8c2e', paddingRight: 10, textAlign: 'right' }}>
                <Text strong style={{ fontSize: 13 }}>{m.sectionB || '-'}</Text>
                {m.contentB && <div style={{ fontSize: 12, color: '#888', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }}>{m.contentB}</div>}
              </div>
              </div>
              <Progress
                percent={m.similarity}
                strokeColor={m.similarity >= 60 ? '#f5222d' : m.similarity >= 40 ? '#fa8c16' : '#52c41a'}
                showInfo={false}
                size="small"
              />
            </div>
          ))}
        </Card>
      )}

      {/* 分析模块卡片 */}
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      {report.tabs?.length > 0 && report.tabs.map((tab: any) => (
        <Card
          key={tab.key}
          title={
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 6, height: 20, borderRadius: 3,
                background: tab.key === 'structure' ? '#1677ff' : tab.key === 'references' ? '#722ed1' : tab.key === 'terms' ? '#13c2c2' : '#fa8c16',
              }} />
              <span>{tab.label}</span>
            </div>
          }
        >
          {tab.intro && <Paragraph type="secondary" style={{ marginBottom: 12 }}>{tab.intro}</Paragraph>}
          {tab.conclusions?.map((c: string, ci: number) => (
            <Alert
              key={ci}
              message={c}
              type={conclusionSeverity(c)}
              showIcon
              style={{ marginBottom: 8, borderRadius: 8 }}
            />
          ))}
        </Card>
      ))}
    </Space>
  )
}
