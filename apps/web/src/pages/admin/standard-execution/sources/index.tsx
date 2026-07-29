import { useEffect, useState, useContext } from 'react'
import { SEPageContext } from '../../../../contexts/SEPageContext'
import {
  Table, Typography, Button, Space, Select, Input, Tag, message,
  Drawer, Form, Modal, Upload, Card, Divider, Tabs, List, Popconfirm,
} from 'antd'
import type { Key } from 'react'
import {
  ReloadOutlined, CloudUploadOutlined,
  EditOutlined, FileTextOutlined, CheckCircleOutlined, EyeOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons'
import type { UploadFile, UploadProps } from 'antd'
import dayjs from 'dayjs'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  seListSources, seListSourcesEnterprise,
  seCreateSource, seCreateSourceEnterprise,
  seUpdateSource, seUpdateSourceEnterprise,
  seDisableSource, seDisableSourceEnterprise,
  seBatchDisableSources, seBatchDisableSourcesEnterprise,
  seBatchDeleteSources, seBatchDeleteSourcesEnterprise,
  seListRequirements, seListRequirementsEnterprise,
  seListSourceVersionsEnterprise, seCreateSourceVersionEnterprise,
  seStartParseV2,
  type Source,
  type Requirement,
  SOURCE_TYPE_LABEL,
} from '../../../../api/standardExecution'
import { nodeApi } from '../../../../api/client'
import { sanitizeSEVisibleText } from '../../../../utils/sePresentation'

const { Text } = Typography
const { TextArea } = Input

const SOURCE_TYPE_OPTIONS = Object.entries(SOURCE_TYPE_LABEL).map(([value, label]) => ({ value, label }))
type ImportMode = 'none' | 'upload' | 'manual' | 'template'
type SourceListRow = Source & {
  requirementCount?: number | null
  checkpointCount?: number | null
}
type StandardFileUploadResp = { fileUrl?: string; rawText?: string }

const getSourceCheckpointCount = (row: Source) => {
  const source = row as SourceListRow
  return source.requirementCount ?? source.checkpointCount ?? 0
}

// ─── 国内预置标准模板数据 ──────────────────────────────────────────
interface TemplateItem {
  id: string
  title: string
  sourceType: string
  sourceNo: string
  version: string
  description: string
  scene: string
  requirementCount: number
  rawText: string
}

const PRESET_TEMPLATES: TemplateItem[] = [
  {
    id: 'tpl-audit',
    title: '客户验厂通用执行依据',
    sourceType: 'CHECKLIST',
    sourceNo: 'BXZ-AUDIT-2024',
    version: '2024版',
    description: '覆盖质量、安全、环境三大类，适用于各类制造业企业应对客户供应商审核',
    scene: '客户验厂 / 供应商审核',
    requirementCount: 32,
    rawText: `客户验厂通用执行依据

第一章 质量管理体系

1.1 质量管理文件
应建立质量手册、程序文件和作业指导书，文件应受控并定期评审更新。责任部门应确认所有有效文件均已下发至相关岗位。

1.2 进货检验（IQC）
原材料、外购件进厂时应进行检验，检验依据应为有效的检验标准或规范，检验结果应完整记录并保存不少于一年。不合格品应隔离标识并及时处理。

1.3 过程检验（IPQC）
生产过程中应设置检验点，关键工序应有检验记录。首件检验、巡检频次应符合控制计划要求，检验数据应可追溯到具体批次和操作员。

1.4 成品检验（OQC）
出货前应进行成品全检或抽检，检验报告应包括检验项目、判定结果、检验人员签字。不合格品不得出货。

1.5 不合格品控制
不合格品应标识隔离，处置记录应包括：不合格描述、原因分析、处置方式（返工/报废/让步）、验证结果。

1.6 纠正措施（8D/CAPA）
客户投诉或内部重大不合格应启动纠正措施，记录应包括：问题描述、根本原因、纠正措施、效果验证、关闭日期。

1.7 量具与校准
生产和检验用测量设备应定期校准，校准记录应包括设备编号、校准日期、结果、下次校准日期。过期未校准设备不得使用。

1.8 供应商管理
应建立合格供应商名录，对供应商应定期评估（至少每年一次），评估记录应包括质量、交货、服务等维度。

第二章 安全生产

2.1 安全生产责任制
应制定各岗位安全生产职责，负责人应签字确认。新员工入职须接受安全培训，记录应含培训内容、时长、签到表。

2.2 危险源辨识
应对工作场所危险源进行辨识和评估，形成危险源清单，并制定对应控制措施。危险源清单应每年更新。

2.3 设备安全检查
生产设备应定期检查，检查记录应包括设备名称、检查内容、检查结果、发现问题及整改情况。特种设备须持证操作。

2.4 消防安全
消防设施应定期检查，灭火器应在有效期内，逃生通道不得堵塞。每年至少组织一次消防应急演练并留存记录。

2.5 个人防护
涉及噪声、粉尘、化学品等岗位应提供合适的个人防护用品，员工应正确使用，使用情况应有记录。

第三章 环境管理

3.1 废弃物管理
应建立固废、危废分类管理制度，危废应委托有资质单位处置，处置合同和联单应妥善保存。

3.2 有害物质管控
应建立有害物质（RoHS/REACH/重金属等）管控清单，原材料应要求供应商提供符合性声明，进厂应检验或核查。

3.3 节能减排
应记录主要能耗数据（电、水、燃气），对能耗异常应分析原因并采取措施。`,
  },
  {
    id: 'tpl-safety',
    title: 'GB/T 33000-2016 企业安全生产标准化基本规范',
    sourceType: 'TECH_STANDARD',
    sourceNo: 'GB/T 33000-2016',
    version: '2016版',
    description: '国家标准，适用于工贸类企业安全生产标准化建设与达标评审',
    scene: '安全生产检查 / 达标评审',
    requirementCount: 28,
    rawText: `GB/T 33000-2016 企业安全生产标准化基本规范

5 核心要求

5.1 目标职责

5.1.1 安全生产目标
企业应根据自身安全生产实际，制定文件化的安全生产总目标和年度目标。目标应包含生产安全事故死亡率、重伤率等量化指标，并分解到各部门和岗位。

5.1.2 安全生产责任制
企业应建立安全生产责任制，明确各层级、各部门、各岗位的安全生产职责，并以文件形式发布。每年应对安全生产责任制执行情况进行考核，考核结果应记录。

5.1.3 安全生产投入
企业应依法提取和使用安全生产费用，建立安全费用台账，记录提取金额、使用项目、审批情况。

5.2 制度化管理

5.2.1 安全生产规章制度
企业应建立健全安全生产规章制度，至少包括：安全生产责任制、操作规程、教育培训、检查、隐患排查治理、应急救援等制度。制度应定期评审，至少每3年修订一次。

5.2.2 操作规程
企业应针对生产工艺、设备、设施等编制操作规程，操作规程应明确操作步骤、安全要点和应急处置措施，并下发至岗位操作人员。

5.3 教育培训

5.3.1 安全教育培训计划
企业应制定年度安全培训计划，培训计划应涵盖：主要负责人、安全管理人员、班组长、特种作业人员、新入厂人员、转岗人员等各类培训。

5.3.2 主要负责人及安全管理人员培训
主要负责人和安全生产管理人员应经专门机构培训，取得安全生产知识和管理能力考核合格证书，并定期参加继续教育。

5.3.3 从业人员安全培训
新入厂员工须进行三级安全教育（公司级、部门级、班组级），培训学时符合规定，考核合格后方可上岗。教育培训记录应含内容、学时、考核结果、人员签名。

5.3.4 特种作业人员培训
从事电工、焊接、起重、压力容器、危化品等特种作业人员，须持有特种作业操作证，证件在有效期内，到期前应复审。

5.4 现场管理

5.4.1 安全设施
生产现场应配备必要的安全防护设施，设施应完好有效。安全设施台账应记录设施名称、位置、状态、检查周期。

5.4.2 职业健康管理
接触职业病危害因素的员工应定期参加职业健康检查，检查结果应存入员工职业健康档案。企业应对检测结果超标的岗位采取整改措施。

5.4.3 危险化学品安全
危化品储存应符合隔离、通风、防泄漏要求，配备应急处置器材。危化品台账记录应包含名称、数量、存放位置、安全数据表（SDS）编号。

5.4.4 相关方管理
承包商、供应商进入生产区域前，应进行安全教育，并签订安全协议。发包单位应对承包方进行安全监督检查。

5.5 隐患排查治理

5.5.1 隐患排查
企业应制定隐患排查制度，明确排查类型（日常、专项、综合）、频次、范围和方法。班组日常检查、部门专项检查、企业综合检查应分别留存记录。

5.5.2 隐患治理
发现隐患应立即整改，不能立即整改的，应制定整改方案，明确责任人、整改时限、临时防护措施，并跟踪验证闭环。

5.6 应急管理

5.6.1 应急预案
企业应编制综合应急预案和专项应急预案，预案应经过审批发布，并定期评审修订（至少每3年一次）。

5.6.2 应急演练
企业应每年至少组织一次综合应急演练，专项预案演练每半年至少一次。演练后应总结评估，完善预案，演练记录应包含时间、参与人员、演练内容、评估结论。

5.6.3 应急物资
企业应配备应急物资和装备，建立台账，定期检查更新，确保处于完好状态。`,
  },
  {
    id: 'tpl-quality',
    title: 'GB/T 19001-2016 质量管理体系要求（执行版）',
    sourceType: 'TECH_STANDARD',
    sourceNo: 'GB/T 19001-2016',
    version: '2016版（等同 ISO 9001:2015）',
    description: '质量管理体系国家标准，适用于ISO认证企业的内审和日常体系维护',
    scene: 'ISO认证内审 / 质量体系外审',
    requirementCount: 38,
    rawText: `GB/T 19001-2016 质量管理体系要求（执行依据摘录）

4 组织环境

4.1 理解组织及其环境
组织应确定与其宗旨和战略方向相关的外部和内部因素。应对这些因素进行监视和评审，并记录结果。

4.2 相关方需求
组织应确定与质量管理体系有关的相关方及其需求和期望，并对该信息进行监视和评审。

4.4 质量管理体系过程
应对每个过程确定：所需的输入、预期的输出、过程顺序和相互作用、职责和权限，并维持文件化信息。

5 领导作用

5.1 最高管理者承诺
最高管理者应证实对质量管理体系的领导作用和承诺，包括：确保质量方针和目标符合战略方向、促进过程方法和基于风险的思维。

5.2 质量方针
组织应建立、实施和保持质量方针，质量方针应文件化，传达并可获取，必要时可向相关方提供。

5.3 岗位职责权限
最高管理者应确保在组织内分配、沟通和理解相关岗位的职责、权限和相互关系，并保持文件化信息。

6 策划

6.1 应对风险和机遇
组织应考虑外部和内部因素，确定需要应对的风险和机遇，策划应对措施并评价其有效性，保持相关文件化信息。

6.2 质量目标
组织应针对相关职能、层次和过程建立质量目标。目标应可测量、被监视、定期更新，并传达至相关人员，保持文件化信息。

7 支持

7.1.5 监视和测量资源
组织应确定需要监视和测量资源，这些资源应适宜、维护，确保结果有效。测量设备应按规定的时间间隔或在使用前进行校准，校准结果应予以记录。

7.2 能力
组织应确定并提供所需的人员能力，采取措施以获取所需能力，评价措施的有效性，保持适当的文件化信息。

7.3 意识
组织应确保在其控制下工作的人员意识到质量方针、相关质量目标、其对质量管理体系有效性的贡献，以及不符合质量管理体系要求的后果。

7.4 沟通
组织应确定与质量管理体系相关的内部和外部沟通，包括：沟通什么、何时沟通、与谁沟通、如何沟通、由谁沟通。

7.5 文件化信息
组织应保持和保留文件化信息，确保其适宜性和可用性，受到充分保护。对文件化信息进行分发、访问、检索和使用，以及存储和保护应有规定。

8 运行

8.1 运行策划和控制
组织应通过策划、实施、控制、保持和评审，确保满足产品和服务提供的要求，保留必要的文件化信息。

8.2 产品和服务的要求
组织应建立与产品和服务相关的要求，对这些要求进行评审，确保有能力满足，并保留评审结果的文件化信息。

8.4 外部提供过程、产品和服务的控制
组织应确定对外部提供的过程、产品和服务的控制类型和程度。应对外部供方进行评价和选择，监控其绩效，并保留相关文件化信息。

8.5 生产和服务提供

8.5.1 生产和服务提供的控制
组织应在受控条件下实施生产和服务，包括：获取文件化信息、适宜的监视和测量、使用合适的基础设施、配备胜任人员。

8.5.2 标识和可追溯性
组织应使用适宜的方法标识输出，当可追溯性是要求时，应控制输出的唯一性标识，并保留必要的文件化信息。

8.5.6 更改控制
组织应对生产和服务更改进行评审和控制，保留文件化信息，描述更改评审结果、批准更改人员及必要措施。

8.6 产品和服务的放行
组织应在适当阶段实施策划安排，以验证产品和服务是否满足要求，保留放行证据的文件化信息，包括符合准则的证据及可追溯到授权放行的人员。

8.7 不合格输出的控制
组织应确保识别和控制不合格输出，采取适当处置方式，保留不合格的描述、采取措施及让步放行的授权的文件化信息。

9 绩效评价

9.1 监视、测量、分析和评价
组织应确定需要监视和测量的对象及方法，评价质量管理体系的绩效和有效性，保留文件化信息作为结果的证据。

9.1.2 顾客满意
组织应监视顾客对其需求和期望满足程度的感受，确定获取、监视和评审该信息的方法，记录相关结果。

9.2 内部审核
组织应按策划的时间间隔进行内部审核，内审应涵盖质量管理体系所有过程，记录内审结果，报告最高管理者，并跟踪不合格的纠正措施关闭情况。

9.3 管理评审
最高管理者应按策划的时间间隔对质量管理体系进行评审，输入应包括审核结果、顾客反馈、过程绩效等，评审结论应包括改进机会和变更需求，保留文件化信息。

10 改进

10.2 不合格和纠正措施
出现不合格时，组织应采取措施控制、纠正，通过评审确定根本原因，采取消除原因的措施，验证措施有效性，必要时更新风险和机遇，保留文件化信息。

10.3 持续改进
组织应持续改进质量管理体系的适宜性、充分性和有效性，包括考虑分析和评价的结果、管理评审的输出，以确定是否有需要解决的差距或不足。`,
  },
]

export default function SeSourcesPage() {
  const loc = useLocation()
  const nav = useNavigate()
  const isEnterprise = loc.pathname.startsWith('/enterprise')

  const [items, setItems] = useState<Source[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 20
  const [filterType, setFilterType] = useState('')
  const [keyword, setKeyword] = useState('')
  const [selectedKeys, setSelectedKeys] = useState<Key[]>([])
  const [selectedSource, setSelectedSource] = useState<Source | null>(null)
  const [sourceTextExpanded, setSourceTextExpanded] = useState(false)
  const [basisLoading, setBasisLoading] = useState(false)
  const [basisDetail, setBasisDetail] = useState<Requirement | null>(null)
  const [versionOpen, setVersionOpen] = useState(false)
  const [versionSource, setVersionSource] = useState<Source | null>(null)
  const [versionRows, setVersionRows] = useState<Source[]>([])
  const [versionLoading, setVersionLoading] = useState(false)
  const [versionForm] = Form.useForm()
  const [parseV2StartingId, setParseV2StartingId] = useState<string | null>(null)

  const [importMode, setImportMode] = useState<ImportMode>('none')
  const [importWizardOpen, setImportWizardOpen] = useState(false)

  // 上传流程状态
  const [uploadStep, setUploadStep] = useState(0)
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [uploadedFileUrl, setUploadedFileUrl] = useState('')
  const [extractedText, setExtractedText] = useState('')
  const [uploadSourceForm] = Form.useForm()
  const [uploadLoading, setUploadLoading] = useState(false)

  // 手动录入 Drawer
  const [manualOpen, setManualOpen] = useState(false)
  const [editRow, setEditRow] = useState<Source | null>(null)
  const [manualForm] = Form.useForm()

  const openImportWizard = (mode: Exclude<ImportMode, 'none'> = 'upload') => {
    setEditRow(null)
    setImportMode(mode)
    setUploadStep(0)
    setImportWizardOpen(true)
  }

  const closeImportWizard = () => {
    setImportWizardOpen(false)
    setImportMode('none')
    setUploadStep(0)
    setFileList([])
    setUploadedFileUrl('')
    setExtractedText('')
    setEditRow(null)
    uploadSourceForm.resetFields()
  }

  // ─── 查看正文 ─────────────────────────────────────────────────
  const [viewTextOpen, setViewTextOpen] = useState(false)
  const [viewTextSource, setViewTextSource] = useState<Source | null>(null)

  // ─── 预置模板 ─────────────────────────────────────────────────
  const [templateModalOpen, setTemplateModalOpen] = useState(false)
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateItem | null>(null)
  const [templatePreviewOpen, setTemplatePreviewOpen] = useState(false)
  const [templateLoading, setTemplateLoading] = useState(false)

  const sourceMetrics = {
    active: items.filter((item) => item.status === 'ACTIVE').length,
    generatedContents: items.reduce((sum, item) => sum + getSourceCheckpointCount(item), 0),
    pendingParse: items.filter((item) => item.rawText && getSourceCheckpointCount(item) === 0).length,
  }

  const load = async () => {
    setLoading(true)
    try {
      const fetchFn = isEnterprise ? seListSourcesEnterprise : seListSources
      const res = await fetchFn({
        sourceType: filterType || undefined,
        keyword: keyword || undefined,
        page,
        pageSize,
      })
      setItems(res.data)
      setTotal(res.total)
      setSelectedSource((current) => {
        if (current && res.data.some((item) => item.id === current.id)) return current
        return isEnterprise ? null : (res.data[0] ?? null)
      })
      setSelectedKeys([])
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [page, filterType])

  const loadBasisDetail = async (sourceId: string) => {
    setBasisLoading(true)
    try {
      const fetchFn = isEnterprise ? seListRequirementsEnterprise : seListRequirements
      const res = await fetchFn({ sourceId, status: 'ACTIVE,REVIEW_PENDING,DRAFT', pageSize: 1 })
      setBasisDetail(res.data[0] ?? null)
    } catch {
      setBasisDetail(null)
    } finally {
      setBasisLoading(false)
    }
  }
  useEffect(() => {
    if (selectedSource?.id) loadBasisDetail(selectedSource.id)
    else setBasisDetail(null)
  }, [selectedSource?.id])

  useEffect(() => {
    if (!isEnterprise || !selectedSource) return undefined
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedSource(null)
        setSourceTextExpanded(false)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isEnterprise, selectedSource])

  // ─── 上传流程 ─────────────────────────────────────────────────
  const handleFileUpload: UploadProps['customRequest'] = async (options) => {
    const file = options.file as File
    setUploadLoading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await nodeApi.post<unknown, StandardFileUploadResp>('/api/admin/uploads/standard-file', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 300000,
      })
      setUploadedFileUrl(res.fileUrl || '')
      setExtractedText(res.rawText || '')
      uploadSourceForm.setFieldsValue({ rawText: res.rawText || '', fileUrl: res.fileUrl || '' })
      options.onSuccess?.(res)
      setUploadStep(1)
      message.success('文件已上传，请确认内容后保存')
    } catch {
      message.error('上传失败，请重试')
      options.onError?.(new Error('上传失败'))
    } finally {
      setUploadLoading(false)
    }
  }

  const handleUploadSave = async () => {
    try {
      const values = await uploadSourceForm.validateFields()
      const createFn = isEnterprise ? seCreateSourceEnterprise : seCreateSource
      await createFn({ ...values, fileUrl: uploadedFileUrl })
      message.success('文档来源已创建')
      closeImportWizard()
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  // ─── 手动录入 ─────────────────────────────────────────────────
  const openCreate = () => {
    setEditRow(null)
    manualForm.resetFields()
    setManualOpen(true)
  }
  const openEdit = (row: Source) => {
    setEditRow(row)
    manualForm.setFieldsValue(row)
    setManualOpen(true)
  }
  const handleManualSave = async () => {
    try {
      const values = await manualForm.validateFields()
      if (editRow) {
        const updateFn = isEnterprise ? seUpdateSourceEnterprise : seUpdateSource
        await updateFn(editRow.id, values)
        message.success('已更新')
      } else {
        const createFn = isEnterprise ? seCreateSourceEnterprise : seCreateSource
        await createFn(values)
        message.success('文档来源已创建')
      }
      if (importWizardOpen && !editRow) {
        closeImportWizard()
      } else {
        setManualOpen(false)
      }
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      if (err?.response?.data?.error) message.error(err.response.data.error)
    }
  }

  const openVersions = async (row: Source) => {
    setVersionSource(row)
    setVersionOpen(true)
    setVersionLoading(true)
    versionForm.resetFields()
    versionForm.setFieldsValue({ title: row.title, analyze: 'yes' })
    try {
      const res = await seListSourceVersionsEnterprise(row.id)
      setVersionRows(res.data ?? [])
    } catch {
      message.error('加载版本历史失败')
    } finally {
      setVersionLoading(false)
    }
  }

  const handleCreateVersion = async () => {
    if (!versionSource) return
    try {
      const values = await versionForm.validateFields()
      setVersionLoading(true)
      const res = await seCreateSourceVersionEnterprise(versionSource.id, {
        title: values.title || versionSource.title,
        version: values.version,
        rawText: values.rawText || versionSource.rawText,
        analyze: values.analyze !== 'no',
      })
      message.success(`新版本已创建，影响 ${res.affectedRequirementIds.length} 个控制点`)
      const rows = await seListSourceVersionsEnterprise(versionSource.id)
      setVersionRows(rows.data ?? [])
      versionForm.resetFields()
      versionForm.setFieldsValue({ title: res.data.title, analyze: 'yes' })
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '创建新版本失败')
    } finally {
      setVersionLoading(false)
    }
  }

  // ─── 停用 ─────────────────────────────────────────────────────
  const handleDisable = (row: Source) => {
    Modal.confirm({
      title: '停用文档来源',
      content: `确定将「${row.title}」标记为停用吗？已生成的任务保留来源快照，不会受影响。`,
      onOk: async () => {
        try {
          const disableFn = isEnterprise ? seDisableSourceEnterprise : seDisableSource
          await disableFn(row.id)
          message.success('已停用')
          load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }

  // ─── 批量停用 + 导出 ──────────────────────────────────────────
  const handleBatchDisable = () => {
    Modal.confirm({
      title: '批量停用',
      content: `确认停用选中的 ${selectedKeys.length} 个文档来源？已生成的任务不会受影响，已停用的会自动跳过。`,
      onOk: async () => {
        try {
          const fn = isEnterprise ? seBatchDisableSourcesEnterprise : seBatchDisableSources
          const r = await fn(selectedKeys as string[])
          message.success(`已停用 ${r.ok} 项${r.skipped ? `，${r.skipped} 项已停用/跳过` : ''}`)
          setSelectedKeys([])
          load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '操作失败')
        }
      },
    })
  }
  const handleBatchDelete = async () => {
    try {
      const fn = isEnterprise ? seBatchDeleteSourcesEnterprise : seBatchDeleteSources
      const r = await fn(selectedKeys as string[])
      message.success(`已删除 ${r.deleted} 个文档来源`)
      setSelectedKeys([])
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '删除失败')
    }
  }
  const handleDeleteSource = (row: Source) => {
    Modal.confirm({
      title: '删除文档来源',
      content: `确定删除「${row.title}」吗？已生成的任务保留来源快照，不会受影响。`,
      okText: '删除',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          const fn = isEnterprise ? seBatchDeleteSourcesEnterprise : seBatchDeleteSources
          const r = await fn([row.id])
          message.success(`已删除 ${r.deleted} 个文档来源`)
          load()
        } catch (e) {
          const err = e as { response?: { data?: { error?: string } } }
          message.error(err?.response?.data?.error || '删除失败')
        }
      },
    })
  }
  // ─── 导入预置模板 ─────────────────────────────────────────────
  const handleImportTemplate = async (tpl: TemplateItem) => {
    setTemplateLoading(true)
    try {
      const createFn = isEnterprise ? seCreateSourceEnterprise : seCreateSource
      await createFn({
        title: tpl.title,
        sourceType: tpl.sourceType,
        sourceNo: tpl.sourceNo,
        version: tpl.version,
        rawText: tpl.rawText,
      })
      message.success(`「${tpl.title}」已导入为文档来源，可在任务管理中创建执行任务`)
      setTemplateModalOpen(false)
      closeImportWizard()
      load()
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '导入失败')
    } finally {
      setTemplateLoading(false)
    }
  }

  const { setData: setSEPageData, triggerAsk } = useContext(SEPageContext)
  useEffect(() => {
    setSEPageData({
      pageKey: 'sources',
      summary: `当前文档来源列表（共 ${items.length} 条）：\n` + items.slice(0, 10).map((s) => `- ${sanitizeSEVisibleText(s.title)}（${s.status}）`).join('\n'),
    })
    return () => setSEPageData(null)
  }, [items, setSEPageData])

  const goTaskGeneration = (row?: Source) => {
    if (isEnterprise) {
      nav(row?.id ? `/enterprise/workbench?sourceId=${row.id}` : '/enterprise/workbench')
      return
    }
    const base = '/admin/standard-execution/task-generation'
    nav(row?.id ? `${base}?sourceId=${row.id}` : base)
  }
  const startParseReview = async (row: Source) => {
    if (!row.rawText?.trim()) {
      message.warning('该文档暂无正文，无法解析')
      return
    }
    setParseV2StartingId(row.id)
    try {
      const job = await seStartParseV2(row.id)
      if (job.reused) message.info('已有解析任务在运行，已打开确认页')
      else message.success('解析任务已启动')
      nav(`/admin/standard-execution/sources/${row.id}/parse-review/${job.jobId}`)
    } catch (e) {
      const err = e as { response?: { data?: { error?: string } } }
      message.error(err?.response?.data?.error || '启动解析失败')
    } finally {
      setParseV2StartingId(null)
    }
  }
  const goParsedResults = (row: Source) => {
    if (isEnterprise) {
      setSelectedSource(row)
      setSourceTextExpanded(false)
      return
    }
    const base = isEnterprise ? '/enterprise/sources' : '/admin/standard-execution/sources'
    nav(`${base}?advanced=requirements&sourceId=${row.id}`)
  }

  const enterpriseButtonBase = isEnterprise
    ? { height: 34, borderRadius: 6, fontSize: 13, fontWeight: 500, padding: '0 16px' }
    : undefined
  const enterprisePillBase = isEnterprise
    ? { height: 26, borderRadius: 13, fontSize: 12, fontWeight: 500, padding: '0 12px' }
    : undefined
  const sourceColumns = isEnterprise
    ? [
      {
        title: '文档名称',
        dataIndex: 'title',
        width: 128,
        ellipsis: true,
        render: (v: string, row: Source) => (
          <Typography.Link
            style={{ color: '#2563eb', fontSize: 12, fontWeight: 600 }}
            onClick={(event) => {
              event.stopPropagation()
              setSelectedSource(row)
              setSourceTextExpanded(false)
            }}
          >
            {sanitizeSEVisibleText(v)}
          </Typography.Link>
        ),
      },
      { title: '类型', dataIndex: 'sourceType', width: 60, ellipsis: true, render: (v: string) => <span style={{ color: '#475569', fontSize: 12 }}>{SOURCE_TYPE_LABEL[v] || v}</span> },
      {
        title: '状态',
        dataIndex: 'status',
        width: 66,
        render: (v: string, row: Source) => (
          <Space size={4} wrap>
            <span style={{ color: '#475569', fontSize: 12 }}>{v === 'ACTIVE' ? '启用中' : '已停用'}</span>
            {row.isLatestVersion === false && <Tag style={{ margin: 0 }}>历史</Tag>}
          </Space>
        ),
      },
      {
        title: '生成内容',
        width: 76,
        render: (_: unknown, row: Source) => {
          const count = getSourceCheckpointCount(row)
          return <span style={{ color: '#475569', fontSize: 12 }}>{count} 条</span>
        },
      },
      { title: '更新时间', dataIndex: 'updatedAt', width: 82, render: (v: string) => <span style={{ color: '#475569', fontSize: 12 }}>{dayjs(v).format('MM-DD HH:mm')}</span> },
      {
        title: '操作',
        width: 118,
        render: (_: unknown, row: Source) => {
          return (
            <Space size={6} wrap onClick={(event) => event.stopPropagation()}>
              <Button size="small" type="link" style={{ padding: 0, fontSize: 12 }} onClick={() => openEdit(row)}>编辑</Button>
              <Button size="small" type="link" style={{ padding: 0, fontSize: 12 }} onClick={() => openVersions(row)}>版本</Button>
              {row.rawText && row.isLatestVersion !== false && <Button size="small" type="link" style={{ padding: 0, fontSize: 12 }} onClick={() => goTaskGeneration(row)}>拆解</Button>}
              {row.status === 'ACTIVE' && <Button size="small" type="link" danger style={{ padding: 0, fontSize: 12 }} onClick={() => handleDisable(row)}>停用</Button>}
              <Button size="small" type="link" danger style={{ padding: 0, fontSize: 12 }} onClick={() => handleDeleteSource(row)}>删除</Button>
            </Space>
          )
        },
      },
    ]
    : [
      {
        title: '标准名称',
        dataIndex: 'title',
        width: 150,
        ellipsis: true,
        render: (v: string, row: Source) => (
          <div>
            <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v}</div>
            <div style={{ color: '#8a93a3', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {[row.sourceNo, row.version].filter(Boolean).join(' · ') || '未填写编号'}
            </div>
          </div>
        ),
      },
      { title: '类型', dataIndex: 'sourceType', width: 60, render: (v: string) => SOURCE_TYPE_LABEL[v] || v },
      {
        title: '解析结果', width: 68,
        render: (_: unknown, row: Source) => {
          const count = getSourceCheckpointCount(row)
          return <Tag color={count > 0 ? 'blue' : 'default'}>{count} 条</Tag>
        },
      },
      {
        title: '正文', dataIndex: 'rawText', width: 72,
        render: (v: string, row: Source) => v
          ? (
            <Button
              size="small"
              type="link"
              icon={<EyeOutlined />}
              style={{ padding: 0 }}
              onClick={(event) => { event.stopPropagation(); setViewTextSource(row); setViewTextOpen(true) }}
            >
              查看正文
            </Button>
          )
          : <Tag color="default"><FileTextOutlined /> 未录入</Tag>,
      },
      {
        title: '状态', dataIndex: 'status', width: 64,
        render: (v: string) => <Tag color={v === 'ACTIVE' ? 'green' : 'default'}>{v === 'ACTIVE' ? '启用中' : '已停用'}</Tag>,
      },
      { title: '更新时间', dataIndex: 'updatedAt', width: 66, render: (v: string) => dayjs(v).format('MM-DD') },
      {
        title: '操作', width: 84, render: (_: unknown, row: Source) => (
          <Space direction="vertical" size={2} onClick={(event) => event.stopPropagation()}>
            <Button size="small" onClick={() => openEdit(row)}>编辑</Button>
            {getSourceCheckpointCount(row) > 0 && <Button size="small" onClick={() => goParsedResults(row)}>解析结果</Button>}
            {row.rawText && row.isLatestVersion !== false && <Button size="small" loading={parseV2StartingId === row.id} onClick={() => startParseReview(row)}>解析确认</Button>}
            {row.rawText && <Button size="small" type="primary" title="生成任务草稿" onClick={() => goTaskGeneration(row)}>生成</Button>}
            {row.status === 'ACTIVE' && <Button size="small" danger onClick={() => handleDisable(row)}>停用</Button>}
          </Space>
        ),
      },
    ]

  return (
    <div style={isEnterprise ? { maxWidth: 1100, minWidth: 0 } : undefined}>
      {isEnterprise ? (
        <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', height: 26, borderRadius: 13, background: '#2563eb', color: '#fff', fontSize: 12, fontWeight: 500, padding: '0 12px' }}>
            文档来源
          </span>
          <Space wrap>
            <Button icon={<CloudUploadOutlined />} style={enterpriseButtonBase} onClick={() => openImportWizard('upload')}>文档导入</Button>
            <Button type="primary" icon={<PlayCircleOutlined />} style={enterpriseButtonBase} onClick={() => goTaskGeneration()}>AI 拆解任务</Button>
          </Space>
        </div>
      ) : (
        <Space style={{ marginBottom: 18, justifyContent: 'space-between', width: '100%' }} wrap>
          <Space size={10} wrap>
            <Button type="primary" shape="round">标准来源</Button>
            <Button shape="round" onClick={() => { setImportMode('upload'); setUploadStep(0) }}>文件来源</Button>
          </Space>
          <Space wrap>
            <Button type="primary" icon={<CloudUploadOutlined />} onClick={() => { setImportMode('upload'); setUploadStep(0) }}>上传标准</Button>
            <Button icon={<EditOutlined />} onClick={() => { setImportMode('manual'); openCreate() }}>手动录入</Button>
          </Space>
        </Space>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: isEnterprise ? (selectedSource ? 'minmax(620px, 1fr) minmax(360px, 420px)' : 'minmax(0, 1fr)') : 'minmax(0, 1.55fr) minmax(320px, 0.75fr)', gap: isEnterprise ? 28 : 22, alignItems: 'start', overflowX: isEnterprise ? 'auto' : undefined, paddingBottom: isEnterprise ? 24 : undefined }}>
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: isEnterprise ? 'repeat(2, 190px)' : 'repeat(2, minmax(0, 1fr))', gap: isEnterprise ? 16 : 14, marginBottom: isEnterprise ? 32 : 18 }}>
            {[
              { label: isEnterprise ? '启用文档' : '启用标准', value: sourceMetrics.active, color: '#2563eb' },
              { label: isEnterprise ? '生成内容' : '解析结果', value: sourceMetrics.generatedContents, color: '#16a34a' },
            ].map((item) => (
              <div key={item.label} style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 4px 7px rgba(15, 23, 42, 0.04)', padding: isEnterprise ? '15px 17px' : '18px 20px', borderLeft: `4px solid ${item.color}`, height: isEnterprise ? 88 : undefined }}>
                <div style={{ color: '#64748b', fontSize: isEnterprise ? 12 : 14, fontWeight: 500, marginBottom: isEnterprise ? 9 : 8 }}>{item.label}</div>
                <div style={{ fontSize: isEnterprise ? 28 : 30, fontWeight: 700, lineHeight: 1.1, color: '#0f172a' }}>{item.value}</div>
              </div>
            ))}
          </div>

          {isEnterprise ? (
            <Space style={{ marginBottom: 14, width: '100%', justifyContent: 'space-between' }} wrap>
              <Space wrap>
                <Input.Search
                  placeholder="搜索文档名称/编号"
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onSearch={load}
                  style={{ width: 210 }}
                  allowClear
                />
                <Select options={[{ value: '', label: '全部类型' }, ...SOURCE_TYPE_OPTIONS]} value={filterType} onChange={(v) => { setPage(1); setFilterType(v) }} style={{ width: 150 }} />
                <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
              </Space>
            </Space>
          ) : <Space style={{ marginBottom: 14, width: '100%', justifyContent: 'space-between' }} wrap>
            <Space wrap>
              <Input.Search
                placeholder="搜索标题/编号"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                onSearch={load}
                style={{ width: 210 }}
                allowClear
              />
              <Select options={[{ value: '', label: '全部类型' }, ...SOURCE_TYPE_OPTIONS]} value={filterType} onChange={(v) => { setPage(1); setFilterType(v) }} style={{ width: 150 }} />
              <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
            </Space>
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => goTaskGeneration()}>生成任务草稿</Button>
          </Space>}

          {selectedKeys.length > 0 && (
            <div style={{ marginBottom: 12, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ color: '#475569', fontWeight: 600 }}>已选 {selectedKeys.length} 项</span>
              <Space wrap>
                <Button size="small" danger onClick={handleBatchDisable}>批量停用</Button>
                <Popconfirm
                  title={`确定删除选中的 ${selectedKeys.length} 个文档来源？已生成的任务不会受影响。`}
                  onConfirm={handleBatchDelete}
                  okText="删除"
                  okButtonProps={{ danger: true }}
                >
                  <Button size="small" danger>批量删除</Button>
                </Popconfirm>
                <Button size="small" type="text" onClick={() => setSelectedKeys([])}>取消选择</Button>
              </Space>
            </div>
          )}

          <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', boxShadow: isEnterprise ? 'none' : '0 12px 30px rgba(15, 23, 42, 0.05)' }}>
            <Table
              size="small"
              rowKey="id"
              rowSelection={{ selectedRowKeys: selectedKeys, onChange: setSelectedKeys }}
              loading={loading}
              dataSource={items}
              onRow={(row) => ({
                onClick: () => {
                  setSelectedSource((current) => current?.id === row.id ? null : row)
                  setSourceTextExpanded(false)
                },
                style: {
                  cursor: 'pointer',
                  background: selectedSource?.id === row.id ? '#eff6ff' : undefined,
                },
              })}
              locale={{ emptyText: <div style={{ padding: '56px 0', color: '#8a93a3' }}>{isEnterprise ? '还没有文档来源，点击上方文档导入开始导入' : '还没有标准来源，点击上方导入入口开始导入'}</div> }}
              pagination={isEnterprise ? false : { current: page, total, pageSize, onChange: setPage, showSizeChanger: false }}
              tableLayout={isEnterprise ? 'fixed' : undefined}
              columns={sourceColumns}
            />
          </div>
        </div>

        {(!isEnterprise || selectedSource) && <Space direction="vertical" size={22} style={{ width: '100%' }}>
          {!isEnterprise && (
          <Card style={{ borderRadius: 8, boxShadow: isEnterprise ? '0 6px 9px rgba(15, 23, 42, 0.05)' : '0 16px 36px rgba(15, 23, 42, 0.08)', minHeight: isEnterprise ? 236 : undefined }} styles={{ body: { padding: isEnterprise ? '17px 19px' : 22 } }}>
            <div style={{ fontSize: isEnterprise ? 16 : 18, fontWeight: 700, marginBottom: 14, color: '#0f172a' }}>{isEnterprise ? '文档导入' : '导入标准'}</div>
            <Space wrap style={{ marginBottom: isEnterprise ? 16 : 16 }}>
              <Button type={importMode === 'upload' || importMode === 'none' ? 'primary' : 'default'} shape="round" style={enterprisePillBase} onClick={() => { setImportMode('upload'); setUploadStep(0) }}>文件上传</Button>
              <Button shape="round" style={enterprisePillBase} onClick={() => { setImportMode('manual'); openCreate() }}>手动粘贴</Button>
              <Button shape="round" style={enterprisePillBase} onClick={() => setTemplateModalOpen(true)}>预置模板</Button>
            </Space>

            {uploadStep === 1 ? (
              <Form form={uploadSourceForm} layout="vertical">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                  <Form.Item name="title" label={isEnterprise ? '文档名称' : '来源名称'} rules={[{ required: true, message: '必填' }]}>
                    <Input maxLength={200} placeholder="如：GB/T 19001-2016" />
                  </Form.Item>
                  <Form.Item name="sourceType" label="标准类型" rules={[{ required: true, message: '必填' }]}>
                    <Select options={SOURCE_TYPE_OPTIONS} />
                  </Form.Item>
                  <Form.Item name="sourceNo" label="标准编号">
                    <Input maxLength={100} placeholder="如：GB/T 19001-2016" />
                  </Form.Item>
                  <Form.Item name="version" label="版本号">
                    <Input maxLength={50} placeholder="如：2016版" />
                  </Form.Item>
                </div>
                <Form.Item name="rawText" label="识别正文">
                  <TextArea rows={6} maxLength={500_000} showCount defaultValue={extractedText} />
                </Form.Item>
                <Form.Item name="fileUrl" hidden><Input /></Form.Item>
                <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
                  <Button onClick={() => { setUploadStep(0); setFileList([]) }}>重新上传</Button>
                  <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleUploadSave}>{isEnterprise ? '保存并解析' : '保存来源'}</Button>
                </Space>
              </Form>
            ) : (
              <>
                <Upload.Dragger
                  fileList={fileList}
                  onChange={({ fileList: fl }) => setFileList(fl)}
                  customRequest={handleFileUpload}
                  accept=".pdf,.doc,.docx,.txt"
                  maxCount={1}
                  showUploadList
                  style={{ background: '#f8fbff', borderColor: '#bcd3f7' }}
                >
                  <div style={{ padding: isEnterprise ? '28px 12px' : '28px 12px' }}>
                    <div style={{ color: '#64748b', fontSize: isEnterprise ? 13 : 15, fontWeight: isEnterprise ? 500 : 400 }}>拖拽 PDF / DOCX / TXT 到此处，或点击选择文件</div>
                  </div>
                </Upload.Dragger>
                {uploadLoading && <div style={{ marginTop: 12, color: '#1677ff' }}>正在提取文件内容，请稍候…</div>}
                <Space style={{ justifyContent: 'flex-end', width: '100%', marginTop: 16 }}>
                  <Button type="primary" style={enterpriseButtonBase} onClick={() => setImportMode('upload')}>AI 解析生成内容</Button>
                </Space>
              </>
            )}
          </Card>
          )}

          <Card style={{ borderRadius: 8, boxShadow: isEnterprise ? '0 10px 15px rgba(15, 23, 42, 0.1)' : '0 16px 36px rgba(15, 23, 42, 0.08)', minHeight: isEnterprise ? 452 : undefined }} styles={{ body: { padding: isEnterprise ? '21px 23px' : 24 } }}>
            <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 14 }} align="center">
              <div style={{ fontSize: 18, fontWeight: 700, color: '#0f172a' }}>{isEnterprise ? '文档详情' : '任务依据详情'}</div>
              <Space size={8}>
                {isEnterprise && selectedSource && (
                  <Button
                    size="small"
                    type="primary"
                    disabled={!selectedSource.rawText}
                    onClick={() => goTaskGeneration(selectedSource)}
                  >
                    用此文档拆解任务
                  </Button>
                )}
                {isEnterprise && selectedSource && <Button size="small" type="text" aria-label="关闭文档详情" onClick={() => { setSelectedSource(null); setSourceTextExpanded(false) }}>×</Button>}
                <Button
                  size="small"
                  disabled={isEnterprise && !selectedSource}
                  style={isEnterprise ? { height: 34, borderRadius: 6, padding: '0 12px' } : undefined}
                  onClick={() => triggerAsk(
                    `文档来源：${sanitizeSEVisibleText(selectedSource?.title || '未选择')}｜生成内容：${sanitizeSEVisibleText(basisDetail?.title || '暂无')}｜正文摘要：${sanitizeSEVisibleText(selectedSource?.rawText || '').slice(0, 1800)}`,
                    '这份文档可以怎么转成任务？',
                  )}
                >
                  问小智
                </Button>
              </Space>
            </Space>
            {isEnterprise ? (
              selectedSource ? (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <div>
                    <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: 6 }}>{sanitizeSEVisibleText(selectedSource.title)}</div>
                    <Space size={6} wrap>
                      <Tag color="blue">{SOURCE_TYPE_LABEL[selectedSource.sourceType] || selectedSource.sourceType}</Tag>
                      <Tag color={selectedSource.status === 'ACTIVE' ? 'green' : 'default'}>{selectedSource.status === 'ACTIVE' ? '启用中' : '已停用'}</Tag>
                      {selectedSource.sourceNo && <Tag>{selectedSource.sourceNo}</Tag>}
                    </Space>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px', background: '#f8fafc' }}>
                      <div style={{ color: '#64748b', fontSize: 12, marginBottom: 6 }}>可生成任务内容</div>
                      <div style={{ color: '#0f172a', fontWeight: 700, fontSize: 22 }}>{getSourceCheckpointCount(selectedSource)}</div>
                    </div>
                    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '12px 14px', background: '#f8fafc' }}>
                      <div style={{ color: '#64748b', fontSize: 12, marginBottom: 6 }}>历史生成任务</div>
                      <div style={{ color: '#0f172a', fontWeight: 700, fontSize: 22 }}>-</div>
                    </div>
                  </div>
                  <div style={{ color: '#64748b', fontSize: 12, lineHeight: 1.7 }}>
                    文档与任务是一次性来源记录。文档后续停用、删除、改名或重新解析，不影响已生成任务。
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, color: '#334155', marginBottom: 8 }}>文档内容</div>
                    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 14, color: '#475569', lineHeight: 1.7, background: '#fff', maxHeight: sourceTextExpanded ? 300 : 130, overflowY: sourceTextExpanded ? 'auto' : 'hidden', whiteSpace: 'pre-wrap' }}>
                      {selectedSource.rawText ? sanitizeSEVisibleText(selectedSource.rawText) : '该文档暂无正文。'}
                    </div>
                    {selectedSource.rawText && selectedSource.rawText.length > 180 && (
                      <Button size="small" type="link" style={{ padding: 0, marginTop: 6 }} onClick={() => setSourceTextExpanded((expanded) => !expanded)}>
                        {sourceTextExpanded ? '收起正文' : '展开正文'}
                      </Button>
                    )}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, color: '#334155', marginBottom: 8 }}>生成内容预览</div>
                    {basisLoading ? (
                      <Text type="secondary">正在加载生成内容...</Text>
                    ) : basisDetail ? (
                      <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 14px', color: '#1e40af', lineHeight: 1.7 }}>
                        <div style={{ fontWeight: 600, marginBottom: 6 }}>{basisDetail.clauseNo ? `${basisDetail.clauseNo} ` : ''}{sanitizeSEVisibleText(basisDetail.title)}</div>
                        <div>{sanitizeSEVisibleText(basisDetail.executionDescription || basisDetail.requirementText)}</div>
                      </div>
                    ) : (
                      <Text type="secondary">暂无可生成任务内容，可进入文档拆解工作台生成任务草稿。</Text>
                    )}
                  </div>
                </Space>
              ) : null
            ) : selectedSource ? (
              basisLoading ? (
                <Text type="secondary">正在加载解析结果...</Text>
              ) : basisDetail ? (
                <Space direction="vertical" size={16} style={{ width: '100%' }}>
                  <div>
                    <div style={{ fontWeight: 700, color: '#0f172a', marginBottom: 8 }}>
                      {basisDetail.clauseNo ? `${basisDetail.clauseNo} ` : ''}{basisDetail.title}
                    </div>
                    <div style={{ color: '#475569', lineHeight: 1.7 }}>{basisDetail.executionDescription || basisDetail.requirementText}</div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    <div>
                      <div style={{ color: '#64748b', fontSize: 13, marginBottom: 6 }}>推荐任务类型</div>
                      <div style={{ border: '1px solid #cbd5e1', borderRadius: 6, padding: '10px 12px', color: '#64748b' }}>{basisDetail.recommendedTaskType || '待确认'}</div>
                    </div>
                    <div>
                      <div style={{ color: '#64748b', fontSize: 13, marginBottom: 6 }}>建议部门</div>
                      <div style={{ border: '1px solid #cbd5e1', borderRadius: 6, padding: '10px 12px', color: '#64748b' }}>{basisDetail.applicableDeptIds?.join('、') || '待确认'}</div>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, color: '#334155', marginBottom: 8 }}>提交材料要求</div>
                    <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '14px 16px', color: '#2563eb', lineHeight: 1.7 }}>
                      {basisDetail.submitRequirement || basisDetail.requiredMaterials?.join('、') || '根据任务类型补充提交材料要求。'}
                    </div>
                  </div>
                  <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
                    <Button type="primary" onClick={() => goTaskGeneration(selectedSource)}>生成任务</Button>
                  </Space>
                </Space>
              ) : (
                <Space direction="vertical" size={14} style={{ width: '100%' }}>
                  <Text type="secondary">该文档来源暂无解析结果，可先导入正文后生成任务草稿。</Text>
                  <Button type="primary" disabled={!selectedSource.rawText} onClick={() => goTaskGeneration(selectedSource)}>生成任务草稿</Button>
                </Space>
              )
            ) : (
              <Text type="secondary">选择左侧文档后查看任务依据详情。</Text>
            )}
          </Card>
        </Space>}
      </div>

      <Modal
        title="文档导入"
        open={isEnterprise && importWizardOpen}
        onCancel={closeImportWizard}
        width={760}
        footer={null}
        destroyOnHidden
      >
        <Space wrap style={{ marginBottom: 18 }}>
          <Button type={importMode === 'upload' ? 'primary' : 'default'} shape="round" style={enterprisePillBase} onClick={() => { setImportMode('upload'); setUploadStep(0) }}>文件上传</Button>
          <Button type={importMode === 'manual' ? 'primary' : 'default'} shape="round" style={enterprisePillBase} onClick={() => { setImportMode('manual'); setEditRow(null); setTimeout(() => manualForm.resetFields(), 0) }}>手动粘贴</Button>
          <Button type={importMode === 'template' ? 'primary' : 'default'} shape="round" style={enterprisePillBase} onClick={() => setImportMode('template')}>预置模板</Button>
        </Space>

        {importMode === 'manual' ? (
          <Form form={manualForm} layout="vertical">
            <Form.Item name="title" label="文档名称" rules={[{ required: true, message: '必填' }]}>
              <Input maxLength={200} placeholder="如：GB/T 19001-2016 质量管理体系" />
            </Form.Item>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Form.Item name="sourceType" label="文档类型" rules={[{ required: true, message: '必填' }]}>
                <Select options={SOURCE_TYPE_OPTIONS} />
              </Form.Item>
              <Form.Item name="sourceNo" label="文档编号（可选）">
                <Input maxLength={100} placeholder="如：GB/T 19001-2016" />
              </Form.Item>
            </div>
            <Form.Item name="version" label="版本（可选）">
              <Input maxLength={50} placeholder="如：2016版" />
            </Form.Item>
            <Form.Item name="rawText" label="文档正文">
              <TextArea rows={8} maxLength={500_000} showCount placeholder="粘贴文档正文，保存后可用于生成任务内容" />
            </Form.Item>
            <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
              <Button onClick={closeImportWizard}>取消</Button>
              <Button type="primary" onClick={handleManualSave}>保存并解析</Button>
            </Space>
          </Form>
        ) : importMode === 'template' ? (
          <List
            dataSource={PRESET_TEMPLATES}
            renderItem={(tpl) => (
              <List.Item
                style={{ border: '1px solid #e8e8e8', borderRadius: 10, marginBottom: 12, padding: '16px 20px', background: '#fafafa' }}
                actions={[
                  <Button key="preview" size="small" onClick={() => { setSelectedTemplate(tpl); setTemplatePreviewOpen(true) }}>预览内容</Button>,
                  <Button key="import" type="primary" size="small" autoInsertSpace={false} loading={templateLoading} onClick={() => handleImportTemplate(tpl)}><span>确定</span></Button>,
                ]}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{tpl.title}</div>
                  <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>{tpl.description}</div>
                  <Space size={6}>
                    <Tag color="blue">{tpl.sourceNo}</Tag>
                    <Tag color="green">适用：{tpl.scene}</Tag>
                    <Tag>约 {tpl.requirementCount} 条生成内容</Tag>
                  </Space>
                </div>
              </List.Item>
            )}
          />
        ) : uploadStep === 1 ? (
          <Form form={uploadSourceForm} layout="vertical">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <Form.Item name="title" label="文档名称" rules={[{ required: true, message: '必填' }]}>
                <Input maxLength={200} placeholder="如：GB/T 19001-2016" />
              </Form.Item>
              <Form.Item name="sourceType" label="文档类型" rules={[{ required: true, message: '必填' }]}>
                <Select options={SOURCE_TYPE_OPTIONS} />
              </Form.Item>
              <Form.Item name="sourceNo" label="文档编号">
                <Input maxLength={100} placeholder="如：GB/T 19001-2016" />
              </Form.Item>
              <Form.Item name="version" label="版本号">
                <Input maxLength={50} placeholder="如：2016版" />
              </Form.Item>
            </div>
            <Form.Item name="rawText" label="识别正文">
              <TextArea rows={6} maxLength={500_000} showCount defaultValue={extractedText} />
            </Form.Item>
            <Form.Item name="fileUrl" hidden><Input /></Form.Item>
            <Space style={{ justifyContent: 'flex-end', width: '100%' }}>
              <Button onClick={() => { setUploadStep(0); setFileList([]) }}>重新上传</Button>
              <Button type="primary" icon={<CheckCircleOutlined />} onClick={handleUploadSave}>保存并解析</Button>
            </Space>
          </Form>
        ) : (
          <>
            <Upload.Dragger
              fileList={fileList}
              onChange={({ fileList: fl }) => setFileList(fl)}
              customRequest={handleFileUpload}
              accept=".pdf,.doc,.docx,.txt"
              maxCount={1}
              showUploadList
              style={{ background: '#f8fbff', borderColor: '#bcd3f7' }}
            >
              <div style={{ padding: '36px 12px' }}>
                <div style={{ color: '#64748b', fontSize: 14, fontWeight: 500 }}>拖拽 PDF / DOCX / TXT 到此处，或点击选择文件</div>
              </div>
            </Upload.Dragger>
            {uploadLoading && <div style={{ marginTop: 12, color: '#1677ff' }}>正在提取文件内容，请稍候…</div>}
          </>
        )}
      </Modal>

      {/* ─── 查看正文 Drawer ──────────────────────────────── */}
      <Drawer
        title={
          <div>
            <div style={{ fontWeight: 600 }}>{viewTextSource?.title}</div>
            <div style={{ fontSize: 12, color: '#8a93a3', fontWeight: 400, marginTop: 2 }}>
              {viewTextSource?.sourceNo} {viewTextSource?.version && `· ${viewTextSource.version}`}
            </div>
          </div>
        }
        open={viewTextOpen}
        width={700}
        onClose={() => setViewTextOpen(false)}
        footer={
          <Space style={{ float: 'right' }}>
            {viewTextSource?.rawText && (
              <Button onClick={() => goTaskGeneration(viewTextSource!)}>{isEnterprise ? '用此文档拆解任务' : '生成任务草稿'}</Button>
            )}
            <Button type="primary" onClick={() => setViewTextOpen(false)}>关闭</Button>
          </Space>
        }
      >
        {viewTextSource?.rawText ? (
          <div>
            <div style={{
              background: '#f8f9fa',
              border: '1px solid #e8e8e8',
              borderRadius: 8,
              padding: '16px 20px',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.8,
              fontSize: 14,
              color: '#222',
              maxHeight: 'calc(100vh - 200px)',
              overflowY: 'auto',
              fontFamily: '"Noto Serif SC", "Source Han Serif", "SimSun", serif',
            }}>
              {viewTextSource.rawText}
            </div>
            <div style={{ marginTop: 12, color: '#8a93a3', fontSize: 12 }}>
              <Text type="secondary">共 {viewTextSource.rawText.length} 字 · 这是企业自行导入的来源文档，完整可见</Text>
            </div>
          </div>
        ) : (
          <div style={{ color: '#8a93a3', textAlign: 'center', padding: 40 }}>该来源暂无录入正文</div>
        )}
      </Drawer>

      {/* ─── 手动录入 Drawer ─────────────────────────────── */}
      <Drawer
        title={isEnterprise ? (editRow ? '编辑文档来源' : '手动粘贴文档来源') : (editRow ? '编辑标准来源' : '手动录入标准来源')}
        open={manualOpen}
        width={560}
        onClose={() => { setManualOpen(false); setImportMode('none') }}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => { setManualOpen(false); setImportMode('none') }}>取消</Button>
            <Button type="primary" onClick={handleManualSave}>保存</Button>
          </Space>
        }
      >
        <Tabs defaultActiveKey="basic" items={[
          {
            key: 'basic',
            label: '基本信息',
            children: (
              <Form form={manualForm} layout="vertical">
                <Form.Item name="title" label={isEnterprise ? '文档名称' : '来源名称'} rules={[{ required: true, message: '必填' }]}>
                  <Input maxLength={200} placeholder="如：GB/T 19001-2016 质量管理体系" />
                </Form.Item>
                <Form.Item name="sourceType" label="标准类型" rules={[{ required: true, message: '必填' }]}>
                  <Select options={SOURCE_TYPE_OPTIONS} />
                </Form.Item>
                <Form.Item name="sourceNo" label="标准编号（可选）">
                  <Input maxLength={100} placeholder="如：GB/T 19001-2016" />
                </Form.Item>
                <Form.Item name="version" label="版本（可选）">
                  <Input maxLength={50} placeholder="如：2016版" />
                </Form.Item>
                <Form.Item name="fileUrl" label="文件链接（可选）">
                  <Input maxLength={500} placeholder="https://..." />
                </Form.Item>
                <Divider style={{ margin: '12px 0' }} />
                <Form.Item name="rawText" label={<span>来源正文 <span style={{ color: '#8a93a3', fontSize: 12 }}>（填入后可用于生成任务内容）</span></span>}>
                  <TextArea rows={8} maxLength={500_000} showCount placeholder="粘贴来源文档正文，用于后续 AI 分析和生成任务内容" />
                </Form.Item>
              </Form>
            ),
          },
        ]} />
      </Drawer>

      <Drawer
        title={`版本历史：${versionSource?.title || ''}`}
        open={versionOpen}
        width={760}
        onClose={() => setVersionOpen(false)}
      >
        <Table<Source>
          size="small"
          rowKey="id"
          loading={versionLoading}
          dataSource={versionRows}
          pagination={false}
          columns={[
            { title: '版本', dataIndex: 'version', width: 110, render: (v: string | null) => v || '-' },
            { title: '标题', dataIndex: 'title', ellipsis: true },
            {
              title: '状态',
              width: 100,
              render: (_: unknown, row) => row.isLatestVersion ? <Tag color="green">最新</Tag> : <Tag>历史</Tag>,
            },
            { title: '上传时间', dataIndex: 'createdAt', width: 145, render: (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm') },
          ]}
        />
        <Divider />
        <Form form={versionForm} layout="vertical">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 12 }}>
            <Form.Item name="title" label="新版本标题">
              <Input maxLength={200} />
            </Form.Item>
            <Form.Item name="version" label="新版本号" rules={[{ required: true, message: '必填' }]}>
              <Input maxLength={80} placeholder="如：2026版" />
            </Form.Item>
          </div>
          <Form.Item name="analyze" label="变更分析" initialValue="yes">
            <Select options={[
              { value: 'yes', label: '创建后分析变更并标记控制点' },
              { value: 'no', label: '仅保存版本，不分析' },
            ]} />
          </Form.Item>
          <Form.Item name="rawText" label="新版本正文" rules={[{ required: true, message: '请粘贴新版本正文' }]}>
            <TextArea rows={10} maxLength={500_000} showCount placeholder="粘贴新版本标准正文，系统将与当前版本进行条款级差异分析" />
          </Form.Item>
          <Button type="primary" loading={versionLoading} onClick={handleCreateVersion}>
            上传新版本
          </Button>
        </Form>
      </Drawer>

      {/* ─── 预置模板选择 Modal ──────────────────────────── */}
      <Modal
        title="选择预置标准模板"
        open={templateModalOpen}
        onCancel={() => { setTemplateModalOpen(false); setImportMode('none') }}
        width={800}
        footer={null}
      >
        <div style={{ color: '#666', fontSize: 13, marginBottom: 16 }}>
          以下模板基于国内通用标准整理，导入后会保存为文档来源。
        </div>
        <List
          dataSource={PRESET_TEMPLATES}
          renderItem={(tpl) => (
            <List.Item
              style={{
                border: '1px solid #e8e8e8',
                borderRadius: 10,
                marginBottom: 12,
                padding: '16px 20px',
                background: '#fafafa',
              }}
              actions={[
                <Button
                  key="preview"
                  size="small"
                  onClick={() => { setSelectedTemplate(tpl); setTemplatePreviewOpen(true) }}
                >
                  预览内容
                </Button>,
                <Button
                  key="import"
                  type="primary"
                  size="small"
                  autoInsertSpace={false}
                  loading={templateLoading}
                  onClick={() => handleImportTemplate(tpl)}
                >
                  <span>确定</span>
                </Button>,
              ]}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{tpl.title}</div>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 6 }}>{tpl.description}</div>
                <Space size={6}>
                  <Tag color="blue">{tpl.sourceNo}</Tag>
                  <Tag color="green">适用：{tpl.scene}</Tag>
                  <Tag>约 {tpl.requirementCount} 条生成内容</Tag>
                </Space>
              </div>
            </List.Item>
          )}
        />
      </Modal>

      {/* ─── 模板内容预览 ────────────────────────────────── */}
      <Drawer
        title={`模板预览：${selectedTemplate?.title}`}
        open={templatePreviewOpen}
        width={660}
        onClose={() => setTemplatePreviewOpen(false)}
        footer={
          <Space style={{ float: 'right' }}>
            <Button onClick={() => setTemplatePreviewOpen(false)}>关闭</Button>
            <Button
              type="primary"
              autoInsertSpace={false}
              loading={templateLoading}
              onClick={() => { setTemplatePreviewOpen(false); if (selectedTemplate) handleImportTemplate(selectedTemplate) }}
            >
              <span>确定</span>
            </Button>
          </Space>
        }
      >
        {selectedTemplate && (
          <div>
            <Space style={{ marginBottom: 12 }} wrap>
              <Tag color="blue">{selectedTemplate.sourceNo}</Tag>
              <Tag color="green">适用：{selectedTemplate.scene}</Tag>
              <Tag>约 {selectedTemplate.requirementCount} 条生成内容</Tag>
            </Space>
            <div style={{
              background: '#f8f9fa',
              border: '1px solid #e8e8e8',
              borderRadius: 8,
              padding: '16px 20px',
              whiteSpace: 'pre-wrap',
              lineHeight: 1.8,
              fontSize: 13,
              color: '#333',
              maxHeight: 'calc(100vh - 250px)',
              overflowY: 'auto',
            }}>
              {selectedTemplate.rawText}
            </div>
          </div>
        )}
      </Drawer>

    </div>
  )
}
