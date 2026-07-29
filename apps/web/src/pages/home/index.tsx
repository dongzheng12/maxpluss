import { useState, useEffect } from 'react'
import { Card, Col, Row, Typography, Input, Space, Tag, Divider, Modal, Button } from 'antd'
import {
  SearchOutlined,
  DiffOutlined,
  TeamOutlined,
  NodeIndexOutlined,
  AppstoreOutlined,
  PhoneOutlined,
  GlobalOutlined,
  SafetyOutlined,
  RocketOutlined,
  CrownOutlined,
  DatabaseOutlined,
  ThunderboltOutlined,
  ApiOutlined,
  SolutionOutlined,
  RightOutlined,
  MessageOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { getHomeData } from '../../api/app'

const { Title, Paragraph, Text } = Typography

/* ── 公告列表（从 API 获取，fallback 空）── */

/* ── 核心工具（6 个，3x2 大卡）── */
const coreTools = [
  { icon: <MessageOutlined />, title: '呼叫小智', desc: 'AI 标准编写辅助', path: '/chat', color: '#2f54eb' },
  { icon: <SearchOutlined />, title: '标准信息查询', desc: '标准信息智能查询', path: '/standards', color: '#1677ff' },
  { icon: <TeamOutlined />, title: '技术委员会', desc: '全国标委会信息查询', path: '/committee', color: '#fa8c16' },
  { icon: <NodeIndexOutlined />, title: '标准图谱', desc: '版本更替链与关联关系', path: '/graph', color: '#722ed1' },
  { icon: <AppstoreOutlined />, title: '行业推荐', desc: '24 大类智能匹配', path: '/standards?mode=industry', color: '#eb2f96' },
  { icon: <DiffOutlined />, title: '文档比对', desc: '逐章节差异分析', path: '/compare', color: '#52c41a' },
]

/* ── 快捷入口（2 个，横条）── */
const quickEntries = [
  { icon: <PhoneOutlined />, title: '标准服务预约', desc: '团标立项、标准编制、技术审查', path: '/booking', color: '#2f54eb' },
  { icon: <CrownOutlined />, title: '会员中心', desc: '享受知识库检索与比对报告权益', path: '/membership', color: '#f5222d' },
]
const chatExamples = [
  '查焊接标准',
  'GB/T 1.1 是什么标准？',
  '生成产品标准大纲',
  '我的比对任务进度',
  '帮我比对文档',
  '扫一扫识别什么？',
]
/* ── 底部特色 ── */
const features = [
  { icon: <DatabaseOutlined />, title: '数据全面', desc: '覆盖多类型知识库', color: '#1677ff' },
  { icon: <ThunderboltOutlined />, title: '智能比对', desc: '逐章节差异分析，支持差异定位', color: '#52c41a' },
  { icon: <ApiOutlined />, title: 'AI 驱动', desc: '一句话生成标准框架大纲，智能匹配标准类型', color: '#722ed1' },
  { icon: <SolutionOutlined />, title: '专业服务', desc: '团标立项、企标制定、技术审查、培训等全流程', color: '#fa8c16' },
]

function useIsMobile(bp = 768) {
  const [m, setM] = useState(window.innerWidth <= bp)
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${bp}px)`)
    const h = (e: MediaQueryListEvent) => setM(e.matches)
    mql.addEventListener('change', h)
    return () => mql.removeEventListener('change', h)
  }, [bp])
  return m
}

const HERO_TAGS_FALLBACK = ['问标准', '写标准', '做任务', '会员服务']

export default function HomePage() {
  const nav = useNavigate()
  const isMobile = useIsMobile()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [stats, setStats] = useState<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [announcements, setAnnouncements] = useState<any[]>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [annDetail, setAnnDetail] = useState<any>(null)
  const [heroQuery, setHeroQuery] = useState('')
  const [heroTags, setHeroTags] = useState<string[]>(HERO_TAGS_FALLBACK)

  useEffect(() => {
    getHomeData()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((res: any) => {
        setStats(res?.heroStats || res)
        setAnnouncements(res?.announcements || [])
      })
      .catch(() => {})
  }, [])

  // 从 CMS 加载 hero 标签，失败时静默使用 fallback
  useEffect(() => {
    fetch('/api/content-config?group=hero_tags')
      .then((r) => r.ok ? r.json() : Promise.reject(r))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((data: any) => {
        const tags: string[] = (data?.items || [])
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((item: any) => item.enabled && item.content)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((item: any) => item.content as string)
        if (tags.length > 0) setHeroTags(tags)
      })
      .catch(() => {/* 静默 fallback */})
  }, [])

  const goAskXiaozhi = (question?: string) => {
    const q = (question ?? heroQuery).trim()
    nav(q ? `/chat?ask=${encodeURIComponent(q)}&autoSend=1` : '/chat')
  }

  return (
    <div>
      {/* ── Hero Banner ── */}
      <div
        style={{
          background: 'linear-gradient(135deg, #0052d9 0%, #2b7fff 50%, #5eabff 100%)',
          borderRadius: 16,
          padding: isMobile ? '28px 18px 24px' : '38px 44px 30px',
          marginBottom: 28,
          color: '#fff',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {!isMobile && <div style={{ position: 'absolute', top: 16, right: 36, opacity: 0.06, fontSize: 200, lineHeight: 1, pointerEvents: 'none' }}>
          <SafetyOutlined />
        </div>}
        {!isMobile && <div style={{ position: 'absolute', bottom: -40, left: -20, opacity: 0.04, fontSize: 160, lineHeight: 1, pointerEvents: 'none' }}>
          <GlobalOutlined />
        </div>}

        <Title level={1} style={{ color: '#fff', marginBottom: 8, fontSize: isMobile ? 36 : 48, fontWeight: 700, letterSpacing: 0 }}>
          呼叫小智
        </Title>
        <Paragraph style={{ color: 'rgba(255,255,255,0.88)', fontSize: isMobile ? 15 : 18, lineHeight: 1.65, marginBottom: isMobile ? 16 : 16, maxWidth: isMobile ? 820 : 'none', whiteSpace: isMobile ? 'normal' : 'nowrap' }}>
          问标准、做任务、找服务、一站式智能助手。仅提供检索与结果引导，不提供标准正文、条款和技术参数。
        </Paragraph>

        {/* 快捷功能入口（内容由 CMS 控制，fallback 到本地默认值） */}
        <div style={{ marginBottom: 18, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {heroTags.map((t) => (
            <Tag
              key={t}
              style={{
                background: 'rgba(255,255,255,0.14)',
                color: '#fff',
                border: '1px solid rgba(255,255,255,0.10)',
                padding: '4px 15px',
                fontSize: 14,
                fontWeight: 500,
                borderRadius: 999,
                lineHeight: '24px',
                marginInlineEnd: 0,
                height: 32,
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              {t}
            </Tag>
          ))}
        </div>

        <div style={{ maxWidth: 680 }}>
          <Input
            value={heroQuery}
            onChange={(e) => setHeroQuery(e.target.value)}
            onPressEnter={() => goAskXiaozhi()}
            size="large"
            placeholder="请输入标准号、关键词或问题"
            style={{
              height: 56,
              borderRadius: 18,
              marginBottom: 12,
              fontSize: 16,
            }}
          />
          <Space wrap size={12}>
            <Button
              size="middle"
              icon={<MessageOutlined />}
              onClick={() => goAskXiaozhi()}
              style={{
                minWidth: 132,
                height: 44,
                background: '#fff',
                color: '#0052d9',
                border: '1px solid rgba(255,255,255,0.98)',
                boxShadow: '0 6px 16px rgba(17, 66, 154, 0.10)',
                borderRadius: 14,
                padding: '0 18px',
                fontSize: 16,
                fontWeight: 500,
              }}
            >
              问问小智
            </Button>
            <Button
              size="middle"
              icon={<SearchOutlined />}
              onClick={() => heroQuery.trim() && nav(`/standards?q=${encodeURIComponent(heroQuery.trim())}`)}
              style={{
                minWidth: 124,
                height: 44,
                borderRadius: 14,
                padding: '0 16px',
                fontSize: 15,
                fontWeight: 400,
                color: '#fff',
                background: 'rgba(255,255,255,0.10)',
                border: '1px solid rgba(255,255,255,0.20)',
                boxShadow: 'none',
              }}
            >
              快速检索
            </Button>
          </Space>
        </div>
        <div style={{ marginTop: 16, marginBottom: 8 }}>
          <Text style={{ color: 'rgba(255,255,255,0.52)', fontSize: 13 }}>你可以直接这样问：</Text>
        </div>
        <div style={{ marginBottom: 0, display: 'flex', flexWrap: 'wrap', gap: 10, maxWidth: isMobile ? '100%' : 900 }}>
          {chatExamples.map((q) => (
            <Tag
              key={q}
              style={{
                cursor: 'pointer',
                background: 'rgba(255,255,255,0.08)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: '#fff',
                padding: '0 13px',
                borderRadius: 999,
                fontSize: 13,
                marginInlineEnd: 0,
                height: 32,
                display: 'inline-flex',
                alignItems: 'center',
                textAlign: 'center',
                whiteSpace: 'nowrap',
                lineHeight: 1,
                maxWidth: isMobile ? 'calc(50% - 5px)' : 'calc(33.333% - 7px)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
              onClick={() => goAskXiaozhi(q)}
            >
              {q}
            </Tag>
          ))}
        </div>
      </div>

      {/* ── 能力概览 4 列 ── */}
      <Row gutter={[12, 12]} style={{ marginBottom: 28 }}>
        {[
          { title: '标准信息知识库', value: stats?.standards ? '可检索' : '—', suffix: '', color: '#1677ff' },
          { title: '比对模式', value: 3, suffix: '种', color: '#52c41a' },
          { title: 'AI 助手能力', value: 4, suffix: '项', color: '#722ed1' },
          { title: '标准服务类型', value: 5, suffix: '类', color: '#fa8c16' },
        ].map((s, i) => (
          <Col xs={12} sm={12} md={6} key={i}>
            <Card style={{ borderTop: `3px solid ${s.color}`, borderRadius: 10, textAlign: 'center' }}>
              <div style={{ fontSize: 12, color: '#999', marginBottom: 4, lineHeight: 1.3 }}>{s.title}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: s.color, lineHeight: 1.2 }}>
                {s.value.toLocaleString()}{s.suffix}
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* ── 公告动态 ── */}
      {announcements.length > 0 && (
        <>
          <Card
            size="small"
            style={{ marginBottom: 20, borderRadius: 10, borderLeft: '4px solid #1677ff' }}
            styles={{ body: { padding: '10px 16px' } }}
          >
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {(announcements.length > 4 ? announcements.slice(0, 3) : announcements).map((a: any) => (
                <div
                  key={a.id}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer', padding: '2px 0' }}
                  onClick={() => setAnnDetail(a)}
                >
                  <Text style={{ fontSize: 13, flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
                    <Tag color="blue" style={{ fontSize: 11, marginRight: 8 }}>公告</Tag>
                    {a.title}
                  </Text>
                  <Space size={4} style={{ flexShrink: 0, marginLeft: 8 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>{a.date}</Text>
                    <RightOutlined style={{ fontSize: 10, color: '#bfbfbf' }} />
                  </Space>
                </div>
              ))}
              {announcements.length > 4 && (
                <Button
                  type="link"
                  size="small"
                  style={{ padding: 0, fontSize: 12, height: 'auto' }}
                  onClick={() => nav('/announcements')}
                >
                  查看全部
                </Button>
              )}
            </Space>
          </Card>
          <Modal
            title={annDetail?.title}
            open={!!annDetail}
            onCancel={() => setAnnDetail(null)}
            footer={<Button type="primary" onClick={() => setAnnDetail(null)}>关闭</Button>}
          >
            <div style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>{annDetail?.date}</div>
            <div style={{ fontSize: 14, lineHeight: 1.8, whiteSpace: 'pre-wrap' }}>{annDetail?.content || '暂无详细内容'}</div>
          </Modal>
        </>
      )}

      {/* ── 核心工具 3x2 ── */}
      <Divider style={{ margin: '4px 0 20px' }}>
        <Space>
          <RocketOutlined style={{ color: '#1677ff' }} />
          <Text strong style={{ fontSize: 16 }}>核心工具</Text>
        </Space>
      </Divider>

      <Row gutter={[16, 16]} style={{ marginBottom: 20 }}>
        {coreTools.map((t) => (
          <Col xs={24} sm={12} md={8} key={t.title}>
            <Card
              hoverable
              onClick={() => nav(t.path)}
              style={{ height: '100%', borderRadius: 10, cursor: 'pointer' }}
              styles={{ body: { padding: '24px 20px', display: 'flex', alignItems: 'flex-start', gap: 14 } }}
            >
              <div
                style={{
                  width: 48, height: 48, borderRadius: 12, flexShrink: 0,
                  background: `${t.color}10`, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 22, color: t.color,
                }}
              >
                {t.icon}
              </div>
              <div>
                <Text strong style={{ fontSize: 15, display: 'block', marginBottom: 4 }}>{t.title}</Text>
                <Text type="secondary" style={{ fontSize: 13, lineHeight: 1.5 }}>{t.desc}</Text>
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {/* ── 快捷入口 ── */}
      <Row gutter={16} style={{ marginBottom: 32 }}>
        {quickEntries.map((t) => (
          <Col xs={24} sm={12} key={t.title}>
            <Card
              hoverable
              onClick={() => nav(t.path)}
              style={{ borderRadius: 10, cursor: 'pointer', borderLeft: `4px solid ${t.color}` }}
              styles={{ body: { padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 14 } }}
            >
              <div style={{ fontSize: 24, color: t.color, flexShrink: 0 }}>{t.icon}</div>
              <div style={{ flex: 1 }}>
                <Text strong style={{ fontSize: 15 }}>{t.title}</Text>
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>{t.desc}</Text>
              </div>
              <Text type="secondary" style={{ fontSize: 18 }}>›</Text>
            </Card>
          </Col>
        ))}
      </Row>

      {/* ── 平台特色 ── */}
      <Divider style={{ margin: '4px 0 20px' }}>
        <Space>
          <SafetyOutlined style={{ color: '#1677ff' }} />
          <Text strong style={{ fontSize: 16 }}>为什么选择标准小智</Text>
        </Space>
      </Divider>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        {features.map((f) => (
          <Col xs={12} sm={12} md={6} key={f.title}>
            <Card
              style={{ height: '100%', background: '#fafbfd', borderRadius: 10, border: '1px solid #f0f0f0' }}
              styles={{ body: { padding: '22px 18px' } }}
            >
              <div style={{ fontSize: 22, color: f.color, marginBottom: 10 }}>{f.icon}</div>
              <Text strong style={{ fontSize: 15, display: 'block', marginBottom: 6 }}>{f.title}</Text>
              <Text type="secondary" style={{ fontSize: 13, lineHeight: 1.6 }}>{f.desc}</Text>
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  )
}
