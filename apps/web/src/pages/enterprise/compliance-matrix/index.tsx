import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { Alert, Button, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { ReloadOutlined } from '@ant-design/icons'
import {
  seGetComplianceMatrixEnterprise,
  type ComplianceMatrixCoverage,
  type ComplianceMatrixRow,
  type ComplianceMatrixSource,
} from '../../../api/standardExecution'
import { sanitizeSEVisibleText } from '../../../utils/sePresentation'

const { Text } = Typography

const pageStyle: CSSProperties = {
  background: '#f6f8fb',
  minHeight: 'calc(100vh - 64px)',
  padding: 0,
}

const metricStyle: CSSProperties = {
  width: 176,
  height: 76,
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  padding: '13px 15px',
  boxShadow: '0 4px 7px rgba(15, 23, 42, 0.04)',
}

const tableShellStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  overflow: 'hidden',
}

function sourceLabel(source: ComplianceMatrixSource | null | undefined) {
  if (!source) return '未标记标准'
  return sanitizeSEVisibleText([source.sourceNo, source.title, source.version ? `v${source.version}` : null].filter(Boolean).join(' · '))
}

function renderCoverageCell(coverage: ComplianceMatrixCoverage | undefined, isOwnSource: boolean) {
  if (coverage?.status === 'DIRECT') {
    return (
      <Tooltip title={`${coverage.recordIds.length} 条有效记录`}>
        <Tag color="green" style={{ margin: 0 }}>已覆盖</Tag>
      </Tooltip>
    )
  }
  if (coverage?.status === 'REUSED') {
    return (
      <Tooltip title={`${coverage.recordIds.length} 条复用记录`}>
        <Tag color="blue" style={{ margin: 0 }}>复用</Tag>
      </Tooltip>
    )
  }
  if (isOwnSource) return <Tag color="red" style={{ margin: 0 }}>未覆盖</Tag>
  return <Text type="secondary">-</Text>
}

export default function EnterpriseComplianceMatrixPage() {
  const [sources, setSources] = useState<ComplianceMatrixSource[]>([])
  const [rows, setRows] = useState<ComplianceMatrixRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [sourceId, setSourceId] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await seGetComplianceMatrixEnterprise({
        page,
        pageSize,
        sourceId,
      })
      setSources(res.data.sources)
      setRows(res.data.rows)
      setTotal(res.total)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [page, pageSize, sourceId])

  const metrics = useMemo(() => {
    const directRows = rows.filter((row) => Object.values(row.coverageBySource).some((coverage) => coverage.status === 'DIRECT')).length
    const reusedRows = rows.filter((row) => Object.values(row.coverageBySource).some((coverage) => coverage.status === 'REUSED')).length
    return {
      total,
      pageRows: rows.length,
      coveredRows: directRows + reusedRows,
      reusedRows,
    }
  }, [rows, total])

  const sourceRowSpans = useMemo(() => {
    const spans: Record<string, number> = {}
    for (let index = 0; index < rows.length;) {
      const sourceIdForGroup = rows[index].sourceId
      let count = 1
      while (index + count < rows.length && rows[index + count].sourceId === sourceIdForGroup) count += 1
      spans[rows[index].id] = count
      for (let offset = 1; offset < count; offset += 1) spans[rows[index + offset].id] = 0
      index += count
    }
    return spans
  }, [rows])

  const columns: ColumnsType<ComplianceMatrixRow> = useMemo(() => {
    const base: ColumnsType<ComplianceMatrixRow> = [
      {
        title: '标准文档',
        width: 220,
        fixed: 'left',
        onCell: (row) => ({ rowSpan: sourceRowSpans[row.id] ?? 1 }),
        render: (_: unknown, row) => (
          <Space direction="vertical" size={2} style={{ width: '100%' }}>
            <Text strong style={{ fontSize: 12 }}>{sourceLabel(row.source)}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>{sanitizeSEVisibleText(row.source?.version ? `版本 ${row.source.version}` : '未记录版本')}</Text>
          </Space>
        ),
      },
      {
        title: '控制点',
        width: 300,
        fixed: 'left',
        render: (_: unknown, row) => (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            <Space size={6}>
              <Tag style={{ margin: 0 }}>{sanitizeSEVisibleText(row.clauseNo || row.id.slice(0, 8))}</Tag>
              <Text strong style={{ fontSize: 12 }}>{sanitizeSEVisibleText(row.title)}</Text>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: sanitizeSEVisibleText(row.requirementText) }}>
              {sanitizeSEVisibleText(row.requirementText)}
            </Text>
          </Space>
        ),
      },
    ]
    const sourceColumns: ColumnsType<ComplianceMatrixRow> = sources.map((source) => ({
      title: (
        <Tooltip title={sourceLabel(source)}>
          <span>{sanitizeSEVisibleText(source.sourceNo || source.title)}</span>
        </Tooltip>
      ),
      width: 132,
      align: 'center',
      render: (_: unknown, row) => renderCoverageCell(row.coverageBySource[source.id], row.sourceId === source.id),
    }))
    return [...base, ...sourceColumns]
  }, [sourceRowSpans, sources])

  return (
    <div style={pageStyle}>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }} wrap>
        <Space wrap>
          <Select
            allowClear
            showSearch
            placeholder="全部标准文档"
            optionFilterProp="label"
            value={sourceId}
            onChange={(value) => { setPage(1); setSourceId(value) }}
            style={{ width: 280 }}
            options={sources.map((source) => ({ value: source.id, label: sourceLabel(source) }))}
          />
          <Select
            value={pageSize}
            onChange={(value) => { setPage(1); setPageSize(value) }}
            style={{ width: 120 }}
            options={[50, 100, 200].map((value) => ({ value, label: `${value} 条/页` }))}
          />
        </Space>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={load}>刷新</Button>
      </Space>

      <Space size={16} wrap style={{ marginBottom: 16 }}>
        <div style={metricStyle}>
          <Text type="secondary" style={{ fontSize: 12 }}>控制点总数</Text>
          <div style={{ marginTop: 6, fontSize: 24, lineHeight: 1.1, color: '#0f172a', fontWeight: 700 }}>{metrics.total}</div>
        </div>
        <div style={metricStyle}>
          <Text type="secondary" style={{ fontSize: 12 }}>当前页控制点</Text>
          <div style={{ marginTop: 6, fontSize: 24, lineHeight: 1.1, color: '#0f172a', fontWeight: 700 }}>{metrics.pageRows}</div>
        </div>
        <div style={metricStyle}>
          <Text type="secondary" style={{ fontSize: 12 }}>当前页覆盖</Text>
          <div style={{ marginTop: 6, fontSize: 24, lineHeight: 1.1, color: '#0f172a', fontWeight: 700 }}>{metrics.coveredRows}</div>
        </div>
        <div style={metricStyle}>
          <Text type="secondary" style={{ fontSize: 12 }}>复用覆盖</Text>
          <div style={{ marginTop: 6, fontSize: 24, lineHeight: 1.1, color: '#0f172a', fontWeight: 700 }}>{metrics.reusedRows}</div>
        </div>
      </Space>

      {total > 200 && (
        <Alert type="info" showIcon message="控制点超过 200 条，矩阵已按页加载。" style={{ marginBottom: 16 }} />
      )}

      <div style={tableShellStyle}>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={rows}
          columns={columns}
          scroll={{ x: 520 + sources.length * 132 }}
          pagination={{
            current: page,
            total,
            pageSize,
            showSizeChanger: false,
            onChange: setPage,
          }}
          locale={{ emptyText: '暂无可展示的 ACTIVE 控制点' }}
        />
      </div>
    </div>
  )
}
