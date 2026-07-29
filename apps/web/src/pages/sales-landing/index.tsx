/**
 * 销售专属推广主页 /s/:salesCode
 * 移动端优先，不强制登录。
 * - 展示销售信息 + 产品卡片
 * - 产品 actionType=REGISTER → /register?salesCode=xxx（写 30d cookie，归因不变）
 * - 产品 actionType=CONTACT  → 新 tab 打开 https://xn--q8qq4wvuikrb.com
 * - 联系销售弹窗：contactVisible=false 时不展示联系方式
 *
 * 设计：深色赛博风（Tailwind + shadcn + lucide），.sales-root scoped 与 AntD 隔离
 */
import { useEffect, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { message } from 'antd'
import {
  MessageCircle, CheckCircle2, Sparkles, FileSearch, FileEdit,
  Bell, Gift, GraduationCap, Headphones, Building2,
  Search, Users, Phone, Copy, QrCode, ChevronRight,
} from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'
import { nodeApi } from '../../api/client'
import './dark-shell.css'

// 微信 JSSDK 注入的全局对象（小程序 webview 场景用 wx.miniProgram.navigateTo）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const wx: any

// ─────────────────────────────── 类型 ───────────────────────────────
interface Product {
  code: string
  name: string
  slogan: string
  description: string
  targetUsers: string
  features: string[]
  actionType: 'REGISTER' | 'CONTACT' | 'INTRO_CONTACT'
  ctaLabel: string
}
interface PublicProfile {
  salesCode: string
  realName: string
  companyName: string | null
  positionTitle: string | null
  avatar: string | null
  bio: string | null
  contactVisible: boolean
  contact: {
    wechat: string | null
    phone: string | null
    qrcode: string | null
  }
  products: Product[]
  wxScheme: string | null  // 微信 URL Scheme，普通微信浏览器内 location.href 拉起小程序
}

// CONTACT 类产品外链：成单线下完成
const PRODUCT_CONTACT_URL = 'https://xn--q8qq4wvuikrb.com'

// 默认兜底
const DEFAULT_BIO = `您好，我是您的标准化服务顾问。

如果您有标准查询、标准管理、标准编写、标准审查、标准监测或企业标准数字化建设需求，可以通过下方产品入口快速了解和使用相关服务。

标准小智不是单一工具，而是一套面向企业标准工作的数字化能力体系，覆盖"管标准、编标准、控标准、用标准"四个方向。

其中，"用标准"重点面向企业生产、质量、安全、供应链、销售、服务和管理等真实业务场景，帮助企业把标准从文件资料，转化为可执行、可追踪、可沉淀的业务规则和管理能力。

如需产品介绍、试用开通、方案沟通或服务对接，也可以直接联系我。`
const DEFAULT_POSITION = '标准数字化解决方案顾问'

// 静态区块
const SERVICES = [
  { Icon: Gift, title: '产品试用开通', desc: '7天会员试用、功能体验、账号权限开通' },
  { Icon: GraduationCap, title: '产品演示讲解', desc: '一对一演示、功能介绍、使用培训' },
  { Icon: Headphones, title: '企业方案对接', desc: '需求沟通、场景诊断、方案初步评估' },
]
const SCENARIOS = [
  { Icon: Building2, label: '企业标准管理' },
  { Icon: FileEdit, label: '标准编写协同' },
  { Icon: Bell, label: '标准动态监测' },
  { Icon: CheckCircle2, label: '安全质量合规' },
  { Icon: Search, label: '供应链集采管理' },
  { Icon: Users, label: '销售服务赋能' },
]

/** 把 salesCode 写入 cookie（30 天），给 /register 页读取 */
function writeSalesCodeCookie(code: string) {
  const maxAge = 30 * 24 * 60 * 60
  document.cookie = `bxz_sales_code=${encodeURIComponent(code)}; max-age=${maxAge}; path=/; SameSite=Lax`
}

export default function SalesLandingPage() {
  const { salesCode } = useParams<{ salesCode: string }>()
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const [loading, setLoading] = useState(true)
  const [profile, setProfile] = useState<PublicProfile | null>(null)
  const [errorStatus, setErrorStatus] = useState<'NOT_FOUND' | 'DISABLED' | 'NOT_PUBLIC' | 'ERROR' | null>(null)
  // 详情页"联系销售"跳回时带 ?contact=1，profile 加载完直接打开联系弹窗
  const [contactDialogOpen, setContactDialogOpen] = useState(searchParams.get('contact') === '1')
  // 微信内打开时启用 <wx-open-launch-weapp> 标签拉起小程序企业版申请页
  const [isWeChat] = useState(() => typeof navigator !== 'undefined' && /MicroMessenger/i.test(navigator.userAgent))

  useEffect(() => {
    if (!salesCode) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true)
    nodeApi.get(`/api/public/sales/${encodeURIComponent(salesCode)}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((res: any) => {
        setProfile(res)
        writeSalesCodeCookie(res.salesCode)
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .catch((e: any) => {
        const st = e?.response?.data?.status
        if (st === 'DISABLED') setErrorStatus('DISABLED')
        else if (st === 'NOT_PUBLIC') setErrorStatus('NOT_PUBLIC')
        else if (e?.response?.status === 404) setErrorStatus('NOT_FOUND')
        else setErrorStatus('ERROR')
      })
      .finally(() => setLoading(false))
  }, [salesCode])

  // 微信内打开时，配置 JS-SDK 让"发给好友"和"分享到朋友圈"显示自定义卡片
  useEffect(() => {
    if (!profile) return
    if (!/MicroMessenger/i.test(navigator.userAgent)) return
    if (typeof wx === 'undefined') return

    const pageUrl = window.location.href.split('#')[0]
    // 仅当 URL 带 ?debug=1 时打开 wx.config debug 弹窗，避免污染真实访客
    const wxDebug = new URL(window.location.href).searchParams.get('debug') === '1'
    const shareTitle = '标准小智｜管、编、控、用一体化标准数字化平台'
    const shareDesc = '让标准从"文件资料"变成"可管理、可编写、可监测、可执行"的企业能力。'
    const shareLink = pageUrl
    const shareImgUrl = 'https://biaozhunxiaozhi.com/og-cover.jpg'

    nodeApi.get(`/api/wechat/jsapi-signature?url=${encodeURIComponent(pageUrl)}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((sig: any) => {
        wx.config({
          debug: wxDebug,
          appId: sig.appId,
          timestamp: sig.timestamp,
          nonceStr: sig.nonceStr,
          signature: sig.signature,
          jsApiList: ['updateAppMessageShareData', 'updateTimelineShareData'],
        })
        wx.ready(() => {
          const payload = { title: shareTitle, desc: shareDesc, link: shareLink, imgUrl: shareImgUrl }
          wx.updateAppMessageShareData(payload)
          wx.updateTimelineShareData({ title: shareTitle, link: shareLink, imgUrl: shareImgUrl })
        })
      })
      .catch(() => { /* 签名失败：保持默认 OG meta 行为，不打扰用户 */ })
  }, [profile])

  const scrollToProducts = () => {
    document.getElementById('products')?.scrollIntoView({ behavior: 'smooth' })
  }

  // ── loading ──
  if (loading) {
    return (
      <div className="sales-root min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-400 text-sm">加载中…</div>
      </div>
    )
  }

  // ── error ──
  if (errorStatus) {
    const title =
      errorStatus === 'DISABLED'   ? '该推广链接已失效'
      : errorStatus === 'NOT_PUBLIC' ? '该推广页尚未发布'
      : errorStatus === 'NOT_FOUND'  ? '推广链接不存在'
      : '加载失败，请稍后重试'
    const subtitle =
      errorStatus === 'DISABLED'   ? '请联系您的销售获取最新链接'
      : errorStatus === 'NOT_PUBLIC' ? '销售本人请登录销售工作台点「立即发布」按钮启用推广页'
      : ''
    return (
      <div className="sales-root min-h-screen bg-slate-950 flex flex-col items-center justify-center px-6">
        <div className="text-white text-lg mb-2">{title}</div>
        {subtitle && <div className="text-slate-400 text-sm mb-6">{subtitle}</div>}
        <Button
          onClick={() => nav('/')}
          className="bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 border-0"
        >返回首页</Button>
      </div>
    )
  }

  if (!profile) return null

  const displayName = profile.realName || '标准小智顾问'
  const positionTitle = profile.positionTitle || DEFAULT_POSITION
  const bio = profile.bio || DEFAULT_BIO
  const hasContact = profile.contactVisible && (
    profile.contact?.wechat || profile.contact?.phone || profile.contact?.qrcode
  )

  // 产品矩阵卡片：用 / 管 / 编 / 控（用标准置首位，作为大单入口）
  // description 字段：｜分隔的 tag 串，渲染时 split('｜') 成 pill badge
  const products = [
    {
      id: 1,
      title: '标准小智 · 用标准',
      categoryBadge: '用',
      badgeColor: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
      subtitle: '标准要求库 → 执行任务 → 证据库 → 审计包。基于标准要求一键配置员工任务，完成后自动沉淀执行记录，用于合规雷达研判，以及投标、检查、内审、验收审计包导出。',
      description: '标准变任务｜记录入证据库｜合规雷达｜一键出包',
      icon: Sparkles,
      buttonLeft: '查看演示',
      buttonRight: '打开小程序',
      iconColor: 'text-blue-400',
      borderColor: 'border-blue-500/30',
    },
    {
      id: 2,
      title: '标准小智 · 管标准',
      categoryBadge: '管',
      badgeColor: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
      subtitle: '统一管理企业标准资产，让标准找得到、看得清、管得住。',
      description: '标准检索｜统一入口｜版本管理｜资产沉淀',
      icon: FileSearch,
      buttonText: '查看详情',
      iconColor: 'text-purple-400',
      borderColor: 'border-purple-500/30',
    },
    {
      id: 3,
      title: '标准小智 · 编标准',
      categoryBadge: '编',
      badgeColor: 'bg-green-500/20 text-green-300 border-green-500/30',
      subtitle: '辅助企业提升标准编写效率，让起草、协同、规范检查更顺畅。',
      description: '协同起草｜格式规范｜术语查询｜结构建议',
      icon: FileEdit,
      buttonText: '查看详情',
      iconColor: 'text-green-400',
      borderColor: 'border-green-500/30',
    },
    {
      id: 4,
      title: '标准小智 · 控标准',
      categoryBadge: '控',
      badgeColor: 'bg-orange-500/20 text-orange-300 border-orange-500/30',
      subtitle: '动态监测标准变化，帮助企业及时识别标准风险和合规影响。',
      description: '标准监测｜有效性追踪｜合规雷达｜动态更新',
      icon: Bell,
      buttonText: '查看详情',
      iconColor: 'text-orange-400',
      borderColor: 'border-orange-500/30',
    },
  ]

  return (
    <div className="sales-root min-h-screen bg-slate-950 relative pb-20">
      {/* 背景网格 */}
      <div className="fixed inset-0 bg-[linear-gradient(to_right,#1e293b_1px,transparent_1px),linear-gradient(to_bottom,#1e293b_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-30"></div>

      {/* 微弱光效 */}
      <div className="fixed top-0 left-1/2 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl"></div>

      <div className="relative z-10">
        {/* 顶部品牌区 */}
        <header className="backdrop-blur-md bg-slate-900/50 border-b border-white/5 sticky top-0 z-50">
          <div className="max-w-md mx-auto px-4 py-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="sales-logo-wrap">
                <img src="/logo-smart-standard.png" alt="标准小智" />
              </div>
              <div>
                <div className="text-white text-sm">标准小智</div>
                <div className="text-slate-400 text-xs">标准智能平台</div>
              </div>
            </div>
            <Badge className="bg-blue-500/20 text-blue-300 border-blue-500/30 text-xs">
              销售专属服务
            </Badge>
          </div>
        </header>

        {/* 首屏 Hero 区域 */}
        <section className="px-4 py-8">
          <div className="max-w-md mx-auto">
            <div className="flex flex-col items-center text-center space-y-4">
              <Avatar className="size-20 ring-2 ring-blue-400/20 shadow-lg">
                {/* 头像 fallback 与个人中心/全站统一:profile.avatar 为空时展示品牌 logo */}
                <AvatarImage src={profile.avatar || '/bxz-logo-mark.png'} alt={displayName} />
                <AvatarFallback className="bg-white">
                  <img src="/bxz-logo-mark.png" alt="标准小智" style={{ width: '70%', height: '70%', objectFit: 'contain' }} />
                </AvatarFallback>
              </Avatar>

              <div className="space-y-2">
                <h1 className="text-2xl text-white">{displayName}</h1>
                <div className="flex flex-col gap-1 items-center">
                  <Badge variant="outline" className="bg-blue-500/10 text-blue-300 border-blue-500/30 text-xs">
                    {positionTitle}
                  </Badge>
                  {profile.companyName && (
                    <Badge variant="outline" className="bg-slate-800/50 text-slate-300 border-slate-700/50 text-xs">
                      {profile.companyName}
                    </Badge>
                  )}
                </div>
              </div>

              <p className="text-slate-300 text-sm leading-relaxed max-w-sm whitespace-pre-line text-left">
                {bio}
              </p>

              <div className="flex gap-3 w-full max-w-xs">
                <Button
                  onClick={() => setContactDialogOpen(true)}
                  className="flex-1 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 shadow-lg shadow-blue-500/40 hover:shadow-blue-500/60 border-0 text-white font-semibold h-11 active:scale-[0.98] transition-all"
                >
                  <MessageCircle className="size-4" />
                  立即咨询
                </Button>
                <Button
                  onClick={scrollToProducts}
                  variant="outline"
                  className="flex-1 bg-slate-800/60 border-slate-500/40 text-slate-100 hover:bg-slate-700/60 hover:border-slate-400/60 font-medium h-11 active:scale-[0.98] transition-all"
                >
                  查看产品
                </Button>
              </div>

              <div className="flex gap-4 pt-2">
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  <CheckCircle2 className="size-3.5 text-green-400" />
                  <span>7天会员试用</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  <CheckCircle2 className="size-3.5 text-green-400" />
                  <span>一对一产品演示</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  <CheckCircle2 className="size-3.5 text-green-400" />
                  <span>企业方案支持</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 产品区 */}
        <section id="products" className="px-4 py-8">
          <div className="max-w-md mx-auto">
            <h2 className="text-xl text-white mb-1 text-center">产品矩阵</h2>
            <p className="text-slate-400 text-xs text-center mb-1">
              围绕企业标准工作全流程，提供管、编、控、用一体化数字化能力。
            </p>
            <p className="text-slate-500 text-[10px] text-center mb-6">
              从标准查询、标准管理、协同编写、动态监测，到企业业务场景中的标准应用，帮助企业把标准真正用起来。
            </p>

            <div className="space-y-3">
              {products.map((product) => {
                const IconComponent = product.icon
                return (
                  <Card
                    key={product.id}
                    className={`backdrop-blur-xl bg-white/5 border ${product.borderColor} hover:bg-white/8 transition-all relative overflow-hidden`}
                  >
                    <CardHeader className="p-4">
                      <Badge className={`absolute top-3 right-3 ${product.badgeColor} text-xs px-2 py-0.5`}>
                        {product.categoryBadge}
                      </Badge>

                      <div className="flex items-start gap-3">
                        <div className="p-2 rounded-lg bg-white/10 backdrop-blur-sm border border-white/10 shrink-0">
                          <IconComponent className={`size-5 ${product.iconColor}`} />
                        </div>

                        <div className="flex-1 min-w-0 pr-8">
                          <h3 className="text-base text-white mb-1">{product.title}</h3>
                          <p className="text-xs text-slate-400 mb-1">{product.subtitle}</p>

                          <div className="flex flex-wrap gap-1.5 mb-3">
                            {product.description.split('｜').map((tag, i) => (
                              <span
                                key={i}
                                className="text-[10px] text-slate-300 bg-white/10 px-2.5 py-1 rounded-full border border-white/10"
                              >
                                {tag.trim()}
                              </span>
                            ))}
                          </div>

                          {/* 用标准（id=1）：双按钮 — "查看演示"跳静态 demo；"咨询方案"微信内拉起小程序（用现有 wxScheme），非微信/无 scheme 走联系弹窗 */}
                          {product.id === 1 ? (
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="flex-1 bg-slate-800/60 border-slate-500/40 text-slate-100 hover:bg-slate-700/60 hover:border-slate-400/60 text-xs h-9 font-medium active:scale-[0.98] transition-all"
                                onClick={() => {
                                  window.location.href = '/demo-yongbiaozhun.html'
                                }}
                              >
                                {'buttonLeft' in product ? product.buttonLeft : '查看详情'}
                                <ChevronRight className="size-3" />
                              </Button>
                              <Button
                                size="sm"
                                className="flex-1 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 border-0 text-white text-xs h-9 font-semibold shadow-lg shadow-blue-500/40 hover:shadow-blue-500/60 active:scale-[0.98] transition-all"
                                onClick={() => {
                                  if (isWeChat && profile.wxScheme) {
                                    window.location.href = profile.wxScheme
                                  } else {
                                    setContactDialogOpen(true)
                                  }
                                }}
                              >
                                {'buttonRight' in product ? product.buttonRight : '打开小程序'}
                                <ChevronRight className="size-3" />
                              </Button>
                            </div>
                          ) : (
                            // 管 / 编 / 控：单按钮查看详情，走外链
                            <Button
                              size="sm"
                              variant="outline"
                              className="w-full bg-slate-800/60 border-slate-500/40 text-slate-100 hover:bg-slate-700/60 hover:border-slate-400/60 text-xs h-9 font-medium active:scale-[0.98] transition-all"
                              onClick={() => {
                                window.open(PRODUCT_CONTACT_URL, '_blank', 'noopener,noreferrer')
                              }}
                            >
                              {'buttonText' in product ? product.buttonText : '查看详情'}
                              <ChevronRight className="size-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardHeader>
                  </Card>
                )
              })}
            </div>
          </div>
        </section>

        {/* 服务说明 */}
        <section className="px-4 py-8">
          <div className="max-w-md mx-auto">
            <h2 className="text-xl text-white mb-1 text-center">我可以为你提供</h2>
            <p className="text-slate-400 text-xs text-center mb-6">专属服务支持</p>

            <div className="grid grid-cols-3 gap-3">
              {SERVICES.map((s, idx) => {
                const { Icon } = s
                return (
                  <Card key={idx} className="backdrop-blur-xl bg-white/5 border border-white/10 hover:bg-white/8 transition-all p-4 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <div className="p-2 rounded-lg bg-blue-500/20 border border-blue-500/30">
                        <Icon className="size-5 text-blue-400" />
                      </div>
                      <div className="text-xs text-white">{s.title}</div>
                      <div className="text-[10px] text-slate-400 leading-tight">{s.desc}</div>
                    </div>
                  </Card>
                )
              })}
            </div>
          </div>
        </section>

        {/* 适用场景 */}
        <section className="px-4 py-8">
          <div className="max-w-md mx-auto">
            <h2 className="text-xl text-white mb-1 text-center">适合这些场景</h2>
            <p className="text-slate-400 text-xs text-center mb-6">覆盖标准工作与企业经营关键环节</p>

            <div className="flex flex-wrap gap-2 justify-center">
              {SCENARIOS.map((s, idx) => {
                const { Icon } = s
                return (
                  <div key={idx} className="backdrop-blur-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all px-3 py-2 rounded-full flex items-center gap-2">
                    <Icon className="size-3.5 text-blue-400" />
                    <span className="text-xs text-slate-200">{s.label}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {/* 底部转化区 */}
        <section className="px-4 py-8 mb-4">
          <div className="max-w-md mx-auto">
            <Card className="backdrop-blur-xl bg-gradient-to-br from-blue-500/10 to-cyan-500/10 border border-blue-500/30 p-6 text-center">
              <h2 className="text-lg text-white mb-2">想了解企业标准数字化怎么落地？</h2>
              <p className="text-sm text-slate-300 mb-4 leading-relaxed">
                点击联系我，可获取产品介绍、试用开通、功能演示及企业标准数字化方案沟通支持。
              </p>
              <Button
                onClick={() => setContactDialogOpen(true)}
                variant="outline"
                className="w-full bg-white/5 border-white/10 text-slate-200 hover:bg-white/10"
              >
                <MessageCircle className="size-4" />
                联系专属顾问
              </Button>
            </Card>
          </div>
        </section>

        {/* 页脚品牌信息 */}
        <footer className="backdrop-blur-md bg-slate-900/50 border-t border-white/5 py-6">
          <div className="max-w-md mx-auto px-4 text-center">
            <div className="text-slate-300 text-sm mb-1">标准小智 · 标准智能平台</div>
            <div className="text-slate-500 text-xs">企业标准数字化与 AI 工具服务</div>
          </div>
        </footer>
      </div>

      {/* 悬浮底部操作栏 — 主"立即联系"渐变 + 阴影发光，次"查看产品"加深对比；safe-area 适配 iPhone 底部 */}
      <div className="fixed bottom-0 left-0 right-0 z-50 backdrop-blur-xl bg-slate-900/90 border-t border-white/10 px-4 py-3 safe-area-inset-bottom">
        <div className="max-w-md mx-auto flex gap-3">
          <Button
            onClick={scrollToProducts}
            variant="outline"
            className="flex-1 bg-slate-800/60 border-slate-500/40 text-slate-100 hover:bg-slate-700/60 hover:border-slate-400/60 h-11 font-medium active:scale-[0.98] transition-all"
          >
            查看产品
          </Button>
          <Button
            onClick={() => setContactDialogOpen(true)}
            className="flex-1 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 shadow-lg shadow-blue-500/40 hover:shadow-blue-500/60 border-0 text-white h-11 font-semibold active:scale-[0.98] transition-all"
          >
            <MessageCircle className="size-4" />
            立即联系
          </Button>
        </div>
      </div>

      {/* 联系销售弹窗 */}
      <Dialog open={contactDialogOpen} onOpenChange={setContactDialogOpen}>
        <DialogContent className="backdrop-blur-xl bg-slate-900/95 border border-white/10 text-white max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-center text-lg">联系销售</DialogTitle>
            <DialogDescription className="text-center text-slate-400 text-sm">
              获取专属服务支持
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col items-center gap-4 py-4">
            <Avatar className="size-20 ring-2 ring-blue-400/30">
              {/* 与首屏 Hero 头像同源 fallback */}
              <AvatarImage src={profile.avatar || '/bxz-logo-mark.png'} alt={displayName} />
              <AvatarFallback className="bg-white">
                <img src="/bxz-logo-mark.png" alt="标准小智" style={{ width: '70%', height: '70%', objectFit: 'contain' }} />
              </AvatarFallback>
            </Avatar>

            <div className="text-center">
              <div className="text-white text-lg mb-1">{displayName}</div>
              <div className="text-slate-400 text-sm">{positionTitle}</div>
              {profile.companyName && (
                <div className="text-slate-400 text-xs">{profile.companyName}</div>
              )}
            </div>

            {hasContact ? (
              <div className="w-full space-y-3">
                {profile.contact.phone && (
                  <div className="backdrop-blur-xl bg-white/5 border border-white/10 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <Phone className="size-4 text-blue-400" />
                        <span className="text-sm text-slate-300">手机号</span>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          navigator.clipboard.writeText(profile.contact.phone!)
                          message.success('已复制手机号')
                        }}
                        className="h-7 text-xs text-blue-400 hover:text-blue-300 hover:bg-blue-500/10"
                      >
                        <Copy className="size-3 mr-1" />
                        复制
                      </Button>
                    </div>
                    <div className="text-white">{profile.contact.phone}</div>
                  </div>
                )}

                {profile.contact.wechat && (
                  <div className="backdrop-blur-xl bg-white/5 border border-white/10 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <MessageCircle className="size-4 text-green-400" />
                        <span className="text-sm text-slate-300">微信号</span>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          navigator.clipboard.writeText(profile.contact.wechat!)
                          message.success('已复制微信号')
                        }}
                        className="h-7 text-xs text-green-400 hover:text-green-300 hover:bg-green-500/10"
                      >
                        <Copy className="size-3 mr-1" />
                        复制
                      </Button>
                    </div>
                    <div className="text-white">{profile.contact.wechat}</div>
                  </div>
                )}

                {profile.contact.qrcode && (
                  <div className="backdrop-blur-xl bg-white/5 border border-white/10 rounded-lg p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <QrCode className="size-4 text-slate-400" />
                      <span className="text-sm text-slate-300">微信二维码</span>
                    </div>
                    <div className="bg-white rounded-lg p-4 flex items-center justify-center">
                      <img src={profile.contact.qrcode} alt="微信二维码" className="size-32 object-contain" />
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="w-full text-center py-4 px-4">
                <div className="text-slate-300 text-sm mb-2">请通过销售分享渠道联系对接人</div>
                <div className="text-slate-500 text-xs">或提交咨询后，销售将主动与您联系</div>
              </div>
            )}

            {hasContact && (profile.contact.phone || profile.contact.wechat) && (
              <div className="w-full flex gap-2">
                {profile.contact.phone && (
                  <Button
                    variant="outline"
                    onClick={() => { window.location.href = `tel:${profile.contact.phone}` }}
                    className="flex-1 bg-white/5 border-white/10 text-slate-200 hover:bg-white/10"
                  >
                    <Phone className="size-4" />
                    拨打电话
                  </Button>
                )}
                {profile.contact.wechat && (
                  <Button
                    onClick={() => { window.location.href = 'weixin://' }}
                    className="flex-1 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-500 hover:to-emerald-500 border-0"
                  >
                    <MessageCircle className="size-4" />
                    打开微信
                  </Button>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
