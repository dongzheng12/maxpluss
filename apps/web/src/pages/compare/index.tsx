/**
 * 文档比对 — 支持全库相似度分析 + 1对1精准比对 + 拍照/扫描识别
 * 全库相似度分析已接通 dedup 服务；识别已接通 recognize API
 */
import { useState, useEffect, useRef } from 'react'
import { useIsMobile } from '../../hooks/useIsMobile'
import {
  Card, Upload, Button, Typography, Space, Table, Tag, message, Statistic, Row, Col, Alert, Radio, Result, Descriptions, Modal, Spin, Tooltip,
} from 'antd'
import { InboxOutlined, PlusOutlined, ReloadOutlined, FileTextOutlined, DeleteOutlined, SearchOutlined, SwapOutlined, CameraOutlined, CheckCircleOutlined, QuestionCircleOutlined } from '@ant-design/icons'
import { createCompareTask, listCompareTasks, libraryCompare, recognizeFile, recognizeAndCompare, deleteCompareTask, retryCompareTask, getQueueStatus } from '../../api/app'
import { useNavigate } from 'react-router-dom'
import { useAccess } from '../../hooks/useAccess'
import { humanizeError } from '../../utils/errorText'

const { Dragger } = Upload
const { Title, Text } = Typography


export default function ComparePage() {
  const isMobile = useIsMobile()
  const nav = useNavigate()
  const { checkAndConsume, getCompareReportAccess, isPro, isPaid, isLoggedIn, requireLogin } = useAccess()

  // Task list
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [tasks, setTasks] = useState<any[]>([])
  const [tasksLoading, setTasksLoading] = useState(false)

  // Launch mode
  const [showLaunch, setShowLaunch] = useState(false)
  const [compareMode, setCompareMode] = useState<'library' | 'pair' | 'recognize'>('library')
  const [fileA, setFileA] = useState<File | null>(null)
  const [fileB, setFileB] = useState<File | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // Recognize result
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [recognizeResult, setRecognizeResult] = useState<any>(null)
  const [taskSubmitted, setTaskSubmitted] = useState(false)

  const loadTasks = async () => {
    setTasksLoading(true)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await listCompareTasks()
      setTasks(res?.items || [])
    } catch { /* ignore */ }
    setTasksLoading(false)
  }

  useEffect(() => {
    if (isLoggedIn) loadTasks()
  }, [isLoggedIn])

  // 自动轮询：分阶段频率（前 5 分钟 3s / 之后 10s / 30 分钟硬停）
  // 30 分钟硬停后只有「重新进入页面 / 手动刷新 / 出现新 pending 任务」才能重启
  // 重新进入页面 / 手动刷新 = 组件重新 mount，pollStartedAtRef 自然回到 null
  // 新 pending 任务 = 当前 pendingNos 中存在不在 stopSnapshotRef 的 taskNo
  const pollStartedAtRef = useRef<number | null>(null)
  const pollStoppedRef = useRef(false)
  const pollStopSnapshotRef = useRef<Set<string>>(new Set())
  // 30 分钟硬停后渲染层提示（驱动 Alert 展示 + 「刷新状态」按钮）
  const [pollStoppedDisplay, setPollStoppedDisplay] = useState(false)
  // 一对一上传限制详情展开
  const [showPairLimitDetail, setShowPairLimitDetail] = useState(false)

  const showFailureReason = (reason?: string) => {
    if (!reason) return
    const displayReason = humanizeError(reason)
    message.info({
      content: <div style={{ maxWidth: 360, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{displayReason}</div>,
      duration: 6,
    })
  }

  const renderStatusTag = (status: string, reason?: string) => {
    const hasReason = status === 'FAILED' && !!reason
    const displayReason = hasReason ? humanizeError(reason) : ''
    return (
      <Space size={4}>
        <Tag color={status === 'COMPLETED' ? 'green' : status === 'FAILED' ? 'red' : 'blue'} style={{ marginInlineEnd: 0 }}>
          {status === 'COMPLETED' ? '完成' : status === 'FAILED' ? '失败' : '处理中'}
        </Tag>
        {hasReason && (
          <Tooltip
            title={<div style={{ maxWidth: 360, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{displayReason}</div>}
            placement="topLeft"
          >
            <span
              role="button"
              tabIndex={0}
              aria-label="查看失败原因"
              onClick={(e) => {
                e.stopPropagation()
                showFailureReason(reason)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  showFailureReason(reason)
                }
              }}
              style={{ color: '#ff4d4f', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
            >
              <QuestionCircleOutlined />
            </span>
          </Tooltip>
        )}
      </Space>
    )
  }

  useEffect(() => {
    const pendingNos = new Set(
      tasks
        .filter(t => t.status === 'PENDING' || t.status === 'PROCESSING')
        .map(t => t.taskNo)
    )
    const hasPending = pendingNos.size > 0

    if (!hasPending || showLaunch) {
      // 没 pending → 清状态，下次有任务时从前 5 分钟窗口重新开始
      pollStartedAtRef.current = null
      pollStoppedRef.current = false
      pollStopSnapshotRef.current = new Set()
      if (pollStoppedDisplay) setPollStoppedDisplay(false)
      return
    }

    if (pollStoppedRef.current) {
      // 30 分钟硬停后，只有出现新 pending taskNo 才重启
      let hasNew = false
      for (const no of pendingNos) {
        if (!pollStopSnapshotRef.current.has(no)) { hasNew = true; break }
      }
      if (!hasNew) return
      pollStoppedRef.current = false
      pollStartedAtRef.current = Date.now()
      pollStopSnapshotRef.current = new Set()
      setPollStoppedDisplay(false)
    }

    if (pollStartedAtRef.current === null) {
      pollStartedAtRef.current = Date.now()
    }

    const elapsed = Date.now() - pollStartedAtRef.current
    let delay: number | null
    if (elapsed >= 30 * 60 * 1000) delay = null
    else if (elapsed < 5 * 60 * 1000) delay = 3000
    else delay = 10000

    if (delay === null) {
      pollStoppedRef.current = true
      pollStopSnapshotRef.current = new Set(pendingNos)
      setPollStoppedDisplay(true)
      return
    }

    const id = setTimeout(loadTasks, delay)
    return () => clearTimeout(id)
  }, [tasks, showLaunch, pollStoppedDisplay])

  // 计费说明 — 与小程序一致
  const access = getCompareReportAccess()
  const priceNote = isPro
    ? '专业会员：全库相似度分析不限次'
    : isPaid && access.remaining > 0
      ? `个人会员：全库相似度分析剩余 ${access.remaining} 次`
    : isPaid && access.remaining === 0
      ? '个人会员：本年度全库相似度分析额度已用完，可升级专业版'
      : '会员专属：一对一比对 · 全库相似度分析（个人版 10 次/年，专业版不限次）'
  const priceSuffix = ''

  // 全库相似度分析提交（异步：提交后立即返回任务列表）
  // 排队提示阈值改为 estimateMinutes > 60:超过 60 分钟才弹窗,
  // 60 分钟内静默直接提交。estimateMinutes 由 /queue-status 返回,
  // 后端公式不动(pendingCount * 2)。
  const checkQueue = async (): Promise<boolean> => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const qs: any = await getQueueStatus()
      const estimateMinutes = qs?.data?.estimateMinutes ?? qs?.estimateMinutes ?? 0
      if (estimateMinutes > 60) {
        return new Promise((resolve) => {
          Modal.confirm({
            title: '排队提示',
            content: `当前队列预计等待约 ${estimateMinutes} 分钟，是否继续排队？`,
            okText: '继续排队',
            cancelText: '取消',
            onOk: () => resolve(true),
            onCancel: () => resolve(false),
          })
        })
      }
    } catch { /* ignore */ }
    return true
  }

  // 后端队列保护拒绝处理：409=已有任务，跳到该任务；429=队列满，弹会员升级窗。
  // 返回 true 表示已消化错误（调用方不再 message.error），false 表示未识别需走通用处理
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleQueueGateError = (e: any): boolean => {
    const status = e?.response?.status
    const data = e?.response?.data
    if (status === 409 && data?.error === 'ALREADY_PROCESSING') {
      message.info('您已有任务正在处理，已为您切换到该任务')
      setShowLaunch(false)
      setFileA(null)
      setFileB(null)
      loadTasks()
      return true
    }
    if (status === 429 && data?.error === 'QUEUE_FULL') {
      Modal.confirm({
        title: '当前排队较长',
        content: `您的位置约第 ${data.queuePosition} 位，预计等待 ${data.estimateMinutes} 分钟。开通会员可优先处理。`,
        okText: '去开通会员',
        cancelText: '稍后再试',
        onOk: () => nav('/membership'),
      })
      return true
    }
    return false
  }

  const handleLibrarySubmit = async () => {
    if (!requireLogin()) return
    if (!fileA) { message.warning('请上传文档'); return }
    if (!checkAndConsume('compare')) return
    if (!await checkQueue()) return

    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('file', fileA)
      fd.append('documentName', fileA.name)
      fd.append('title', fileA.name.replace(/\.[^.]+$/, ''))

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await libraryCompare(fd)
      if (res?.taskNo) {
        setTaskSubmitted(true)
        loadTasks()
      } else {
        message.error(res?.error || '提交失败')
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (handleQueueGateError(e)) return
      const errMsg = e?.response?.data?.error || e?.message || '提交失败，请重试'
      message.error(errMsg)
    } finally {
      setSubmitting(false)
    }
  }

  // 1v1 比对提交（会员专属，免费用户后端会返 403 + upgradeUrl）
  const handlePairSubmit = async () => {
    if (!requireLogin()) return
    if (!fileA || !fileB) { message.warning('请上传两个文档'); return }
    if (!await checkQueue()) return

    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('documentName', `${fileA.name} vs ${fileB.name}`)
      fd.append('fileType', fileA.name.split('.').pop() || 'pdf')
      fd.append('compareMode', 'ONE_TO_ONE')
      fd.append('file', fileA)
      fd.append('fileB', fileB)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await createCompareTask(fd)
      if (res?.data?.taskNo || res?.taskNo) {
        setTaskSubmitted(true)
      } else {
        message.success('比对任务已提交')
      }
      setShowLaunch(false)
      setFileA(null)
      setFileB(null)
      loadTasks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      if (handleQueueGateError(e)) return
      // 一对一比对为会员专属，免费用户后端返 403 + upgradeUrl，引导升级
      if (e?.response?.status === 403 && e?.response?.data?.upgradeUrl) {
        Modal.confirm({
          title: '会员专属功能',
          content: e.response.data.error || '一对一比对为会员专属功能，请升级会员后使用',
          okText: '去开通会员',
          cancelText: '稍后',
          onOk: () => nav(e.response.data.upgradeUrl),
        })
        return
      }
      message.error(e?.response?.data?.error || '提交失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  // 识别提交（仅识别）
  const handleRecognizeOnly = async () => {
    if (!requireLogin()) return
    if (!fileA) { message.warning('请上传图片或文档'); return }
    setSubmitting(true)
    setRecognizeResult(null)
    try {
      const fd = new FormData()
      fd.append('file', fileA)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await recognizeFile(fd)
      setRecognizeResult(res)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '识别失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  // 识别 + 全库相似度分析一体化
  const handleRecognizeAndCompare = async () => {
    if (!requireLogin()) return
    if (!fileA) { message.warning('请上传图片或文档'); return }
    if (!checkAndConsume('compare')) return
    setSubmitting(true)
    setRecognizeResult(null)
    try {
      const fd = new FormData()
      fd.append('file', fileA)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res: any = await recognizeAndCompare(fd)
      // If we got a taskNo (library_compared mode), navigate to report
      if (res?.mode === 'library_compared' && res?.taskNo) {
        message.success('识别成功，已完成全库相似度分析')
        nav(`/compare/report/${res.taskNo}`)
        return
      }
      setRecognizeResult(res)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      message.error(e?.response?.data?.error || '识别比对失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  const resetLaunch = () => {
    setShowLaunch(false)
    setFileA(null)
    setFileB(null)
    setCompareMode('library')
    setRecognizeResult(null)
  }

  // 统计
  const doneCount = tasks.filter((t) => t.status === 'COMPLETED').length
  const pendingCount = tasks.filter((t) => t.status === 'PENDING' || t.status === 'PROCESSING').length
  const failedCount = tasks.filter((t) => t.status === 'FAILED').length

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', width: '100%' }}>
        <div>
          <Title level={4} style={{ margin: 0 }}><FileTextOutlined /> 文档比对</Title>
          <Text type="secondary">上传标准文档，全库相似度分析、1 对 1 精准比对</Text>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setShowLaunch(true)}>
          发起比对
        </Button>
      </Space>

      {/* 权限提示 */}
      {!isLoggedIn && (
        <Alert
          type="warning"
          showIcon
          message="登录后可使用文档比对功能。一对一比对和全库相似度分析均为会员专属。"
          action={<Button size="small" type="primary" onClick={() => nav('/login')}>去登录</Button>}
          style={{ marginBottom: 16 }}
        />
      )}

      {showLaunch ? (
        /* ===== 发起比对 ===== */
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {/* 比对模式选择 */}
          <Card title="比对模式">
            <Radio.Group
              value={compareMode}
              onChange={(e) => { setCompareMode(e.target.value); setFileA(null); setFileB(null); setRecognizeResult(null) }}
              style={{ width: '100%' }}
            >
              <Space direction="vertical" style={{ width: '100%' }}>
                <Radio.Button
                  value="library"
                  style={{
                    width: '100%', height: 'auto', padding: '12px 16px',
                    border: compareMode === 'library' ? '2px solid #1677ff' : '1px solid #d9d9d9',
                    borderRadius: 8,
                    background: compareMode === 'library' ? '#e6f4ff' : 'transparent',
                  }}
                >
                  <Space>
                    <SearchOutlined style={{ fontSize: 18, color: '#1677ff' }} />
                    <div>
                      <Text strong style={{ color: compareMode === 'library' ? '#1677ff' : undefined }}>
                        全库相似度分析
                      </Text>
                      <br />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        上传文档，与平台标准化知识库进行相似度比对，生成参考性分析报告
                      </Text>
                    </div>
                  </Space>
                </Radio.Button>

                <Radio.Button
                  value="pair"
                  style={{
                    width: '100%', height: 'auto', padding: '12px 16px',
                    border: compareMode === 'pair' ? '2px solid #1677ff' : '1px solid #d9d9d9',
                    borderRadius: 8,
                    background: compareMode === 'pair' ? '#e6f4ff' : 'transparent',
                  }}
                >
                  <Space>
                    <SwapOutlined style={{ fontSize: 18, color: '#52c41a' }} />
                    <div>
                      <Text strong style={{ color: compareMode === 'pair' ? '#1677ff' : undefined }}>
                        1 对 1 精准比对
                      </Text>
                      <br />
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        上传两个文档，按章节逐项比对相似度
                      </Text>
                    </div>
                  </Space>
                </Radio.Button>

                {/* 扫一扫/拍照识别仅小程序端提供，PC 端不展示 */}
              </Space>
            </Radio.Group>
          </Card>

          {/* 全库相似度分析：单文档上传 */}
          {compareMode === 'library' && (
            <Card title="上传待检文档">
              {fileA ? (
                <Space>
                  <FileTextOutlined style={{ fontSize: 24, color: '#1677ff' }} />
                  <div>
                    <Text strong>{fileA.name}</Text>
                    <br />
                    <Text type="secondary">{(fileA.size / 1024 / 1024).toFixed(2)} MB</Text>
                  </div>
                  <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setFileA(null)}>移除</Button>
                </Space>
              ) : (
                <Dragger
                  accept=".pdf,.doc,.docx,.txt"
                  maxCount={1}
                  showUploadList={false}
                  beforeUpload={(f) => { setFileA(f); return false }}
                >
                  <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                  <p className="ant-upload-text">点击或拖拽上传标准文档</p>
                  <p className="ant-upload-hint">推荐上传 Word 文档，处理速度更快；PDF 扫描件处理时间较长</p>
                </Dragger>
              )}
            </Card>
          )}

          {/* 1v1 比对：双文档上传 */}
          {compareMode === 'pair' && (
            <>
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="适合中短篇文档比对。系统将优先分析文档前 10 万字内容，超出部分暂不参与本次比对；扫描件、图片较多或结构复杂文档可能处理较慢，失败不消耗权益。"
                description={
                  <div style={{ marginTop: 6 }}>
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, height: 'auto' }}
                      onClick={() => setShowPairLimitDetail(s => !s)}
                    >
                      {showPairLimitDetail ? '收起详细限制 ▴' : '查看详细限制 ▾'}
                    </Button>
                    {showPairLimitDetail && (
                      <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 12, color: '#595959', lineHeight: 1.7 }}>
                        <li>单文件：不超过 60 页、6 万字、150 个章节、10MB</li>
                        <li>双文件合计：不超过 120 页、10 万字、300 个章节、20MB</li>
                        <li>若文本已成功抽取但超出范围，系统将优先处理前 10 万字内容</li>
                        <li>扫描件、图片较多、表格复杂、目录层级过深的文档，处理时间可能较长或失败</li>
                        <li>文档超出范围时，建议拆分后上传</li>
                        <li>失败不消耗权益</li>
                      </ul>
                    )}
                  </div>
                }
              />
              <Card title="文档 A（标准一）">
                {fileA ? (
                  <Space>
                    <FileTextOutlined style={{ fontSize: 24, color: '#1677ff' }} />
                    <div>
                      <Text strong>{fileA.name}</Text>
                      <br />
                      <Text type="secondary">{(fileA.size / 1024 / 1024).toFixed(2)} MB</Text>
                    </div>
                    <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setFileA(null)}>移除</Button>
                  </Space>
                ) : (
                  <Dragger
                    accept=".pdf,.doc,.docx,.txt"
                    maxCount={1}
                    showUploadList={false}
                    beforeUpload={(f) => { setFileA(f); return false }}
                  >
                    <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                    <p className="ant-upload-text">点击或拖拽上传文档</p>
                    <p className="ant-upload-hint">推荐上传 Word 文档，处理速度更快；PDF 扫描件处理时间较长</p>
                  </Dragger>
                )}
              </Card>

              <Card title="文档 B（标准二）">
                {fileB ? (
                  <Space>
                    <FileTextOutlined style={{ fontSize: 24, color: '#52c41a' }} />
                    <div>
                      <Text strong>{fileB.name}</Text>
                      <br />
                      <Text type="secondary">{(fileB.size / 1024 / 1024).toFixed(2)} MB</Text>
                    </div>
                    <Button type="text" danger icon={<DeleteOutlined />} onClick={() => setFileB(null)}>移除</Button>
                  </Space>
                ) : (
                  <Dragger
                    accept=".pdf,.doc,.docx,.txt"
                    maxCount={1}
                    showUploadList={false}
                    beforeUpload={(f) => { setFileB(f); return false }}
                  >
                    <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                    <p className="ant-upload-text">点击或拖拽上传文档</p>
                    <p className="ant-upload-hint">推荐上传 Word 文档，处理速度更快；PDF 扫描件处理时间较长</p>
                  </Dragger>
                )}
              </Card>
            </>
          )}

          {/* 识别模式：上传照片 / 扫描件 */}
          {compareMode === 'recognize' && (
            <>
              <Card title="上传标准封面照片或扫描件">
                {fileA ? (
                  <Space>
                    <CameraOutlined style={{ fontSize: 24, color: '#fa8c16' }} />
                    <div>
                      <Text strong>{fileA.name}</Text>
                      <br />
                      <Text type="secondary">{(fileA.size / 1024 / 1024).toFixed(2)} MB</Text>
                    </div>
                    <Button type="text" danger icon={<DeleteOutlined />} onClick={() => { setFileA(null); setRecognizeResult(null) }}>移除</Button>
                  </Space>
                ) : (
                  <Dragger
                    accept=".jpg,.jpeg,.png,.bmp,.pdf"
                    maxCount={1}
                    showUploadList={false}
                    beforeUpload={(f) => { setFileA(f); setRecognizeResult(null); return false }}
                  >
                    <p className="ant-upload-drag-icon"><CameraOutlined /></p>
                    <p className="ant-upload-text">点击或拖拽上传照片 / 扫描件</p>
                    <p className="ant-upload-hint">支持 JPG、PNG、BMP、PDF；系统会自动条码扫描 + OCR 文字识别</p>
                  </Dragger>
                )}
              </Card>

              {/* 识别结果展示 */}
              {recognizeResult && (
                <Card title="识别结果">
                  {recognizeResult.mode === 'standard_found' && (
                    <Result
                      status="success"
                      title={`识别成功：${recognizeResult.standard?.code || ''}`}
                      subTitle={recognizeResult.standard?.title || ''}
                    >
                      <Descriptions column={1} bordered size="small">
                        {recognizeResult.standard?.code && (
                          <Descriptions.Item label="标准号">{recognizeResult.standard.code}</Descriptions.Item>
                        )}
                        {recognizeResult.standard?.title && (
                          <Descriptions.Item label="名称">{recognizeResult.standard.title}</Descriptions.Item>
                        )}
                        {recognizeResult.standard?.status && (
                          <Descriptions.Item label="状态">
                            <Tag color={recognizeResult.standard.status === '现行' ? 'green' : 'orange'}>
                              {recognizeResult.standard.status}
                            </Tag>
                          </Descriptions.Item>
                        )}
                        {recognizeResult.method && (
                          <Descriptions.Item label="识别方式">
                            <Tag>{recognizeResult.method === 'barcode' ? '条码扫描' : 'OCR 文字识别'}</Tag>
                          </Descriptions.Item>
                        )}
                      </Descriptions>
                      <Space style={{ marginTop: 16 }}>
                        <Button type="primary" onClick={() => nav(`/standards/${encodeURIComponent(recognizeResult.standard?.code)}`)}>
                          查看标准信息
                        </Button>
                      </Space>
                    </Result>
                  )}

                  {recognizeResult.mode === 'library_compared' && recognizeResult.taskNo && (
                    <Result
                      status="success"
                      title="识别并比对完成"
                      subTitle={`已识别标准 ${recognizeResult.standard?.code || ''} 并完成全库相似度分析`}
                    >
                      <Button type="primary" onClick={() => nav(`/compare/report/${recognizeResult.taskNo}`)}>
                        查看比对报告
                      </Button>
                    </Result>
                  )}

                  {recognizeResult.mode === 'text_insufficient' && (
                    <Result
                      status="warning"
                      title="未能识别出标准号"
                      subTitle="图片中未检测到有效的标准编号，请尝试拍摄更清晰的标准封面"
                    >
                      {recognizeResult.extractedText && (
                        <Card size="small" title="提取到的文字（前 200 字）" style={{ textAlign: 'left' }}>
                          <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
                            {recognizeResult.extractedText.slice(0, 200)}
                          </Text>
                        </Card>
                      )}
                    </Result>
                  )}

                  {(recognizeResult.mode === 'barcode_found' || recognizeResult.mode === 'barcode_no_match') && (
                    <Result
                      status="info"
                      title={`检测到条码：${recognizeResult.barcode || ''}`}
                      subTitle={recognizeResult.mode === 'barcode_no_match' ? '条码未匹配到标准库中的记录' : ''}
                    />
                  )}
                </Card>
              )}
            </>
          )}

          {/* 计费说明 */}
          {compareMode !== 'recognize' && (
            <Card title="计费说明">
              <Text type="secondary">{priceNote}</Text>
              {priceSuffix && <Tag color="orange" style={{ marginLeft: 8 }}>{priceSuffix}</Tag>}
            </Card>
          )}

          <Space>
            <Button onClick={resetLaunch}>取消</Button>
            {compareMode === 'library' && (
              <Button
                type="primary"
                size="large"
                loading={submitting}
                disabled={!fileA}
                icon={<SearchOutlined />}
                onClick={handleLibrarySubmit}
              >
                开始全库相似度分析{priceSuffix ? ` · ${priceSuffix}` : ''}
              </Button>
            )}
            {compareMode === 'pair' && (
              <Button
                type="primary"
                size="large"
                loading={submitting}
                disabled={!fileA || !fileB}
                icon={<SwapOutlined />}
                onClick={handlePairSubmit}
              >
                提交比对{priceSuffix ? ` · ${priceSuffix}` : ''}
              </Button>
            )}
            {compareMode === 'recognize' && !recognizeResult && (
              <Space>
                <Button
                  type="primary"
                  size="large"
                  loading={submitting}
                  disabled={!fileA}
                  icon={<CameraOutlined />}
                  onClick={handleRecognizeOnly}
                >
                  仅识别标准号
                </Button>
                <Button
                  size="large"
                  loading={submitting}
                  disabled={!fileA}
                  icon={<SearchOutlined />}
                  onClick={handleRecognizeAndCompare}
                >
                  识别 + 全库相似度分析
                </Button>
              </Space>
            )}
            {compareMode === 'recognize' && recognizeResult && (
              <Button onClick={() => { setFileA(null); setRecognizeResult(null) }}>
                重新识别
              </Button>
            )}
          </Space>

          {/* 提交中蒙层弹窗 */}
          <Modal
            open={submitting}
            centered
            closable={false}
            footer={null}
            width={420}
            maskClosable={false}
            maskStyle={{ backgroundColor: 'rgba(0,0,0,0.45)' }}
          >
            <div style={{ textAlign: 'center', padding: '24px 0 8px' }}>
              <Spin size="large" style={{ marginBottom: 20 }} />
              <Typography.Title level={5} style={{ marginBottom: 8 }}>
                {compareMode === 'recognize' ? '正在识别标准信息...' : '正在上传并提交任务...'}
              </Typography.Title>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
                {compareMode === 'library'
                  ? '文档上传后将进入后台处理，预计需要 1-5 分钟。您可以返回首页，稍后再回来查看结果。'
                  : compareMode === 'pair'
                    ? '一对一比对通常需要 30 秒至 2 分钟，取决于文档大小。'
                    : '识别过程通常需要 10-30 秒，请稍候。'}
              </Typography.Paragraph>
              <Button type="link" onClick={() => { nav('/') }}>
                返回首页，稍后查看
              </Button>
            </div>
          </Modal>
        </Space>
      ) : (
        /* ===== 任务列表 ===== */
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {/* PENDING 任务提醒 */}
          {pendingCount > 0 && !pollStoppedDisplay && (
            <Alert
              type="info"
              showIcon
              message={`${pendingCount} 个任务正在后台处理中，完成后将自动更新状态。`}
              description="处理时间通常为 1-5 分钟，您可以先浏览其他页面，稍后再回来查看。"
              style={{ marginBottom: 0 }}
            />
          )}

          {/* 30 分钟轮询停止后，提示用户手动刷新 */}
          {pollStoppedDisplay && (
            <Alert
              type="warning"
              showIcon
              message="任务处理时间较长"
              description="任务仍在后台处理中。自动刷新已暂停，请稍后回到比对历史查看，或点击下方「刷新状态」立即查询。"
              action={
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => {
                    setPollStoppedDisplay(false)
                    pollStoppedRef.current = false
                    pollStartedAtRef.current = Date.now()
                    pollStopSnapshotRef.current = new Set()
                    loadTasks()
                  }}
                >
                  刷新状态
                </Button>
              }
              style={{ marginBottom: 0 }}
            />
          )}

          {/* 概览统计 */}
          <Card>
            <Row gutter={24}>
              <Col span={6}>
                <Statistic title="全部任务" value={tasks.length} />
              </Col>
              <Col span={6}>
                <Statistic title="已完成" value={doneCount} valueStyle={{ color: '#52c41a' }} />
              </Col>
              <Col span={6}>
                <Statistic title="处理中" value={pendingCount} valueStyle={{ color: '#1677ff' }} />
              </Col>
              <Col span={6}>
                <Statistic title="失败" value={failedCount} valueStyle={{ color: failedCount > 0 ? '#ff4d4f' : undefined }} />
              </Col>
            </Row>
          </Card>

          {/* 任务列表 */}
          <Card
            title="比对任务"
            extra={<Button icon={<ReloadOutlined />} onClick={loadTasks} loading={tasksLoading}>刷新</Button>}
          >
            <Table scroll={{ x: "max-content" }}
              rowKey={(r, i) => r.taskNo || r.id || `${i}`}
              dataSource={tasks}
              loading={tasksLoading}
              pagination={{ pageSize: 10 }}
              locale={{ emptyText: isLoggedIn ? '暂无比对任务，点击「发起比对」开始' : '请登录后查看比对任务' }}
              columns={[
                { title: '任务编号', dataIndex: 'taskNo', width: isMobile ? 120 : 180, ellipsis: true },
                {
                  title: '文档名称',
                  dataIndex: 'documentName',
                  render: (v: string) => (
                    <div style={{
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      maxWidth: '100%',
                    }}>{v}</div>
                  ),
                },
                {
                  title: '状态', dataIndex: 'status', width: 110,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  render: (s: string, record: any) => renderStatusTag(s, record.errorMessage),
                },
                {
                  title: '模式', dataIndex: 'compareMode', width: 90, hidden: isMobile,
                  render: (m: string) => (
                    <Tag color={m === 'library' ? 'purple' : 'blue'}>
                      {m === 'library' ? '全库' : m === 'ONE_TO_ONE' ? '1v1' : m || '比对'}
                    </Tag>
                  ),
                },
                {
                  title: '创建时间', dataIndex: 'createdAt', width: 160, hidden: isMobile,
                  render: (v: string) => v ? new Date(v).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-',
                },
                {
                  title: '操作', width: isMobile ? 120 : 200,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  render: (_: any, record: any) => (
                    <Space size="small">
                      {record.status === 'COMPLETED' && (
                        <Button type="link" size="small" onClick={() => nav(`/compare/report/${record.taskNo}`)}>查看报告</Button>
                      )}
                      {(record.status === 'PENDING' || record.status === 'PROCESSING') && (
                        <Text type="secondary" style={{ fontSize: 12 }}>处理中...</Text>
                      )}
                      {record.status === 'FAILED' && (
                        <>
                          <Button type="link" size="small" icon={<ReloadOutlined />} onClick={async () => {
                            try {
                              await retryCompareTask(record.taskNo)
                              message.success('已重新提交')
                              loadTasks()
                            } catch { message.error('重试失败') }
                          }}>重试</Button>
                          <Button type="link" size="small" onClick={() => {
                            // 复用 compareMode：1v1 → pair；library → library
                            const mode = record.compareMode === 'ONE_TO_ONE' ? 'pair' : 'library'
                            setCompareMode(mode)
                            setFileA(null)
                            setFileB(null)
                            setShowLaunch(true)
                          }}>重新比对</Button>
                        </>
                      )}
                      <Button
                        type="link"
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        onClick={() => {
                          Modal.confirm({
                            title: '确认删除',
                            content: `确定要删除任务「${record.documentName}」吗？删除后不可恢复。`,
                            okText: '删除',
                            okType: 'danger',
                            cancelText: '取消',
                            onOk: async () => {
                              try {
                                await deleteCompareTask(record.taskNo)
                                message.success('已删除')
                                loadTasks()
                              // eslint-disable-next-line @typescript-eslint/no-explicit-any
                              } catch (e: any) {
                                message.error(e?.response?.data?.error || '删除失败')
                              }
                            },
                          })
                        }}
                      >
                        删除
                      </Button>
                    </Space>
                  ),
                },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ].filter(c => !('hidden' in c && (c as any).hidden))}
            />
          </Card>
        </Space>
      )}

      {/* 全库相似度分析提交成功蒙层弹窗 */}
      <Modal
        open={taskSubmitted}
        centered
        closable={false}
        footer={null}
        width={440}
        maskStyle={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
      >
        <div style={{ textAlign: 'center', padding: '24px 0 8px' }}>
          <CheckCircleOutlined style={{ fontSize: 56, color: '#52c41a', marginBottom: 16 }} />
          <Typography.Title level={4} style={{ marginBottom: 8 }}>任务已提交</Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
            系统正在后台处理全库相似度分析，通常需要 1-5 分钟。
            <br />
            您可以先浏览其他页面，处理完成后回到此页面查看报告。
          </Typography.Paragraph>
          <Space size="middle">
            <Button onClick={() => { setTaskSubmitted(false); resetLaunch() }}>
              查看任务列表
            </Button>
            <Button type="primary" onClick={() => { setTaskSubmitted(false); nav('/') }}>
              返回首页
            </Button>
          </Space>
        </div>
      </Modal>
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
