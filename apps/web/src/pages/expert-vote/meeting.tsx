/**
 * PC Web 用户端 — 会议详情页（P0-2B-1，只读）
 */
import { useEffect, useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { Card, Typography, Space, Button, Descriptions, Spin, Empty, Tag, Alert, message } from 'antd'
import { ArrowLeftOutlined, CopyOutlined } from '@ant-design/icons'
import { getExpertVote } from '../../api/app'

const { Title, Text } = Typography

function isValidHttpUrl(value?: string | null) {
  const raw = value?.trim()
  if (!raw) return false
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export default function ExpertVoteMeetingPage() {
  const { no } = useParams<{ no: string }>()
  const navigate = useNavigate()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!no) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getExpertVote(no).then((d: any) => setData(d))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .catch((e: any) => message.error(e?.response?.data?.error || '加载失败'))
      .finally(() => setLoading(false))
  }, [no])

  if (loading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin /></div>
  if (!data) return <Empty description="申请不存在" />

  const ready = ['MEETING_SCHEDULED', 'VOTING', 'VOTED', 'SIGNING', 'COMPLETED'].includes(data.status)
  // 只有 MEETING_SCHEDULED 才把"打开会议链接"作为主操作
  const isLive = data.status === 'MEETING_SCHEDULED'
  // VOTING / VOTED / SIGNING / COMPLETED：会议作为历史记录展示，不突出入会操作
  const isHistory = ['VOTING', 'VOTED', 'SIGNING', 'COMPLETED'].includes(data.status)
  const pageTitle = isHistory ? '会议信息' : '会议详情'
  const meetingUrl = typeof data.tencentMeetingUrl === 'string' ? data.tencentMeetingUrl.trim() : ''
  const hasMeetingUrl = !!meetingUrl
  const validMeetingUrl = isValidHttpUrl(meetingUrl)

  const copy = (v: string, label: string) => {
    if (!v) return
    navigator.clipboard.writeText(v).then(() => message.success(`${label} 已复制`))
  }

  const openMeetingUrl = () => {
    if (!validMeetingUrl) {
      message.warning('暂无有效会议链接')
      return
    }
    window.open(meetingUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(`/expert-vote/${no}`)}>返回详情</Button>
        <Title level={4} style={{ margin: 0 }}>{pageTitle}</Title>
        {isHistory && <Tag color="default">历史记录</Tag>}
      </Space>
      {isHistory && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={
            data.status === 'COMPLETED'
              ? '会议已结束，本页为会议历史记录。'
              : '会议已结束，专家意见与投票结果整理中，本页为会议历史记录。'
          }
        />
      )}

      {!ready ? (
        <Card>
          <Empty description="会议尚未安排，平台会议确认后将通过站内消息通知。" />
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <Link to="/expert-vote"><Button>返回列表</Button></Link>
          </div>
        </Card>
      ) : (
        <>
          <Card style={{ marginBottom: 16, background: 'linear-gradient(135deg,#1677ff,#4096ff)', color: '#fff' }}>
            <Title level={4} style={{ color: '#fff', margin: 0 }}>{data.meetingTitle || data.projectName}</Title>
            {data.meetingHost && (
              <Text style={{ color: 'rgba(255,255,255,0.85)' }}>主持人：{data.meetingHost}</Text>
            )}
          </Card>

          <Card title="会议时间" style={{ marginBottom: 16 }}>
            <Text style={{ fontSize: 16 }}>
              {data.meetingStartAt ? new Date(data.meetingStartAt).toLocaleString('zh-CN') : '-'}
              {data.meetingEndAt ? ` — ${new Date(data.meetingEndAt).toLocaleString('zh-CN')}` : ''}
            </Text>
          </Card>

          <Card title="腾讯会议" style={{ marginBottom: 16 }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              {data.tencentMeetingId && (
                <div>
                  <Text type="secondary">会议号：</Text>
                  <Tag color="blue" style={{ fontSize: 16 }}>{data.tencentMeetingId}</Tag>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copy(data.tencentMeetingId, '会议号')}>复制</Button>
                </div>
              )}
              {data.tencentMeetingPwd && (
                <div>
                  <Text type="secondary">会议密码：</Text>
                  <Tag color="orange">{data.tencentMeetingPwd}</Tag>
                  <Button size="small" icon={<CopyOutlined />} onClick={() => copy(data.tencentMeetingPwd, '密码')}>复制</Button>
                </div>
              )}
              <div>
                <Text type="secondary">入会链接：</Text>
                <br />
                {validMeetingUrl ? (
                  <Text copyable={{ text: meetingUrl, tooltips: ['复制链接', '已复制'] }} style={{ wordBreak: 'break-all' }}>
                    {meetingUrl}
                  </Text>
                ) : (
                  <Text type="secondary">暂无有效会议链接</Text>
                )}
                {hasMeetingUrl && !validMeetingUrl && (
                  <div style={{ marginTop: 4 }}>
                    <Text type="warning">会议链接格式无效，请联系平台确认。</Text>
                  </div>
                )}
              </div>
              {isLive && (
                <Button type="primary" disabled={!validMeetingUrl} onClick={openMeetingUrl}>
                  在浏览器打开会议链接
                </Button>
              )}
            </Space>
          </Card>

          {(data.meetingHostContact || data.meetingNotes) && (
            <Card title="其他信息" style={{ marginBottom: 16 }}>
              <Descriptions column={1} bordered size="small">
                {data.meetingHostContact && (
                  <Descriptions.Item label="主持人联系">{data.meetingHostContact}</Descriptions.Item>
                )}
                {data.meetingNotes && (
                  <Descriptions.Item label="注意事项">
                    <div style={{ whiteSpace: 'pre-wrap' }}>{data.meetingNotes}</div>
                  </Descriptions.Item>
                )}
              </Descriptions>
            </Card>
          )}

          <Card title="申请概要" style={{ marginBottom: 16 }}>
            <Descriptions column={{ xs: 1, sm: 2 }} bordered size="small">
              <Descriptions.Item label="评审项目">{data.projectName}</Descriptions.Item>
              <Descriptions.Item label="专家数量">{data.expertCount} 位</Descriptions.Item>
              <Descriptions.Item label="申请编号"><Text code>{data.requestNo}</Text></Descriptions.Item>
            </Descriptions>
          </Card>

          <Card title="参会专家">
            {Array.isArray(data.experts) && data.experts.length > 0 ? (
              <Space direction="vertical" style={{ width: '100%' }} size="small">
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                {data.experts.map((e: any) => (
                  <div key={e.id} style={{ padding: 8, borderBottom: '1px dashed #f0f0f0' }}>
                    <Space wrap>
                      <Text strong>{e.expertName}</Text>
                      {e.expertOrg && <Text type="secondary">· {e.expertOrg}</Text>}
                      {e.expertTitle && <Tag color="blue">{e.expertTitle}</Tag>}
                      {e.expertField && <Text type="secondary">{e.expertField}</Text>}
                    </Space>
                  </div>
                ))}
              </Space>
            ) : (
              <Text type="secondary">平台正在确认专家名单，请以后续通知为准。</Text>
            )}
          </Card>

          {data.meetingArrangedAt && (
            <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 16 }}>
              最近一次确认：{new Date(data.meetingArrangedAt).toLocaleString('zh-CN')}
            </Text>
          )}
        </>
      )}
    </div>
  )
}
