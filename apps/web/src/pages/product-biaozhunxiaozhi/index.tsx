/**
 * 产品详情页 /product/biaozhunxiaozhi
 * 重写为「标准小智 · 用标准」企业方案落脚页（原 AI 工具箱介绍页）
 *
 * 三种入口归因（按优先级）：
 *   1. ?from=<salesCode>  → mount 时拉公开接口拿 wxScheme，立即体验走完整 goRegister 三分支
 *   2. cookie bxz_sales_code → H5 /register?salesCode=cookie（不拉小程序）
 *   3. 都没有 → 联系按钮走全局 ContactSalesContext toast 兜底
 */
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, MessageCircle, CheckCircle2, AlertCircle,
  ListChecks, GitBranch, BarChart3, Building2,
  ShieldCheck, Package, TrendingUp,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { nodeApi } from '../../api/client'
import { useContactSales } from '../../contexts/ContactSalesContext'
import '../sales-landing/dark-shell.css'

function readSalesCodeCookie(): string | null {
  const m = document.cookie.match(/(?:^|;\s*)bxz_sales_code=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : null
}

function writeSalesCodeCookie(code: string) {
  const maxAge = 30 * 24 * 60 * 60
  document.cookie = `bxz_sales_code=${encodeURIComponent(code)}; max-age=${maxAge}; path=/; SameSite=Lax`
}

// ── 四大能力卡 ────────────────────────────────────────────────────
const CAPABILITIES = [
  {
    id: 1, title: '标准规则转化', icon: ListChecks,
    gradient: 'from-blue-500/20 to-cyan-500/20', iconBg: 'bg-blue-600',
    description: '将标准条款、制度要求、流程规范和管理要求进行拆解，转化为企业可理解、可配置、可执行的业务规则。',
    features: ['条款拆解', '规则提取', '清单生成'],
    notice: '适用于质量检查、安全培训、供应商准入、验收标准、服务规范等场景。',
  },
  {
    id: 2, title: '业务流程嵌入', icon: GitBranch,
    gradient: 'from-green-500/20 to-emerald-500/20', iconBg: 'bg-green-600',
    description: '把标准要求嵌入企业生产、质量、安全、供应链、销售、服务和管理流程，让标准不再停留在文件中，而是进入日常业务动作。',
    features: ['流程配置', '节点校验', '执行留痕'],
    notice: '适用于采购审批、质量检验、安全巡检、客户服务、销售跟进等流程。',
  },
  {
    id: 3, title: '执行过程追踪', icon: BarChart3,
    gradient: 'from-purple-500/20 to-fuchsia-500/20', iconBg: 'bg-purple-600',
    description: '围绕标准执行过程形成记录、提醒、预警和复盘机制，帮助企业看清标准有没有执行、执行到什么程度、哪里存在风险。',
    features: ['过程记录', '合规雷达', '闭环管理'],
    notice: '适用于合规检查、内审管理、整改跟踪、合规雷达和管理复盘。',
  },
  {
    id: 4, title: '企业定制交付', icon: Building2,
    gradient: 'from-orange-500/20 to-amber-500/20', iconBg: 'bg-orange-600',
    description: '基于企业行业特点、业务场景和现有系统，提供标准数据整理、场景诊断、方案设计、试点交付和持续运营支持。',
    features: ['场景诊断', '方案设计', '试点交付'],
    notice: '适用于企业标准数字化建设、供应链集采、质量安全合规、营销服务赋能等项目。',
  },
]

// ── 三条成交主线 ───────────────────────────────────────────────────
const DEAL_LINES = [
  {
    id: 1, title: '生产合规线', subtitle: '帮企业稳生产、控风险', icon: ShieldCheck, iconBg: 'bg-blue-700',
    gradient: 'from-blue-500/15 to-cyan-500/15', borderColor: 'border-blue-500/30',
    body: '作业靠经验、质量波动、安全培训难闭环、合规检查压力大时，可以将 SOP 标准、质量标准、安全标准和培训要求转化为线上流程、检查清单和执行记录。',
    tags: ['安全生产', '质量合规', '培训考核'],
  },
  {
    id: 2, title: '供应链降本线', subtitle: '帮企业省成本、强管控', icon: Package, iconBg: 'bg-green-700',
    gradient: 'from-green-500/15 to-emerald-500/15', borderColor: 'border-green-500/30',
    body: '采购不透明、供应商难管理、验收无依据、履约难追踪时，可以将供应商准入标准、采购标准、合同标准、验收标准和评价规则嵌入采购全流程。',
    tags: ['供应商准入', '采购规则', '履约验收'],
  },
  {
    id: 3, title: '营销增长线', subtitle: '帮企业获客户、促转化', icon: TrendingUp, iconBg: 'bg-purple-700',
    gradient: 'from-purple-500/15 to-fuchsia-500/15', borderColor: 'border-purple-500/30',
    body: '获客成本高、销售话术不统一、客户线索分散、服务跟进弱时，可以用标准知识生成获客内容、销售方案、客户诊断、服务 SOP 和客户分层运营规则。',
    tags: ['销售赋能', '客户诊断', '服务标准'],
  },
]

// ── 适合企业场景标签 ───────────────────────────────────────────────
const SCENARIOS = [
  '企业标准管理', '安全生产合规', '质量管控追溯',
  '供应链集采管理', '销售服务赋能', '管理看板与合规雷达',
]

export default function ProductBxzPage() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const { openContact } = useContactSales()
  const fromQuery = params.get('from')?.trim() || null

  const salesCode = useMemo(() => fromQuery || readSalesCodeCookie(), [fromQuery])
  const [wxScheme, setWxScheme] = useState<string | null>(null)

  useEffect(() => { window.scrollTo(0, 0) }, [])

  useEffect(() => {
    if (!fromQuery) return
    writeSalesCodeCookie(fromQuery)
    nodeApi.get(`/api/public/sales/${encodeURIComponent(fromQuery)}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((res: any) => { if (res?.wxScheme) setWxScheme(res.wxScheme) })
      .catch(() => { /* 销售停用/不存在不影响展示 */ })
  }, [fromQuery])

  // wxScheme 仅在 goRegister 中使用（保留为次级入口文字链）
  void wxScheme

  const goContact = () => openContact(salesCode)

  const goBack = () => {
    if (window.history.length > 1) {
      nav(-1)
    } else if (salesCode) {
      nav(`/s/${encodeURIComponent(salesCode)}`)
    } else {
      nav('/')
    }
  }

  return (
    <div className="sales-root min-h-screen bg-slate-950 relative pb-24">
      <div className="fixed inset-0 bg-[linear-gradient(to_right,#1e293b_1px,transparent_1px),linear-gradient(to_bottom,#1e293b_1px,transparent_1px)] bg-[size:4rem_4rem] opacity-30"></div>
      <div className="fixed top-0 left-1/2 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl"></div>

      <div className="relative z-10">

        {/* ── sticky header ── */}
        <header className="backdrop-blur-md bg-slate-900/50 border-b border-white/5 sticky top-0 z-50">
          <div className="max-w-md mx-auto px-4 py-3 flex items-center gap-3">
            <button
              onClick={goBack}
              className="inline-flex items-center gap-1 text-slate-200 hover:text-white text-sm"
            >
              <ArrowLeft className="size-4" />
              返回
            </button>
            <div className="flex-1 text-center text-white text-sm">标准小智 · 用标准</div>
            <div className="w-12" />
          </div>
        </header>

        {/* ── 1. Hero 主标题区 ── */}
        <section className="px-4 pt-10 pb-6">
          <div className="max-w-md mx-auto text-center">
            <h2 className="text-2xl text-white mb-2">标准小智 · 用标准</h2>
            <p className="text-sm text-slate-400 leading-relaxed max-w-sm mx-auto">
              基于标准要求库，一键生成执行任务；员工完成后自动沉淀记录，随时生成投标、检查、内审、验收审计包。
            </p>
          </div>
        </section>

        {/* ── 2. 定位说明卡片 ── */}
        <section className="px-4 pb-6">
          <div className="max-w-md mx-auto">
            <Card className="backdrop-blur-xl bg-blue-500/5 border border-blue-500/30 p-4">
              <div className="flex items-start gap-3">
                <div className="shrink-0">
                  <div className="size-10 rounded-lg bg-blue-500/20 border border-blue-500/30 flex items-center justify-center">
                    <AlertCircle className="size-5 text-blue-400" />
                  </div>
                </div>
                <div className="flex-1">
                  <h3 className="text-sm text-white mb-2">它不是简单工具，而是企业标准应用方案</h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    把标准要求库变成员工日常任务，把执行记录沉淀成可随时调取的审计包。投标、检查、内审、验收时一键出包，不再临时翻资料、补记录。
                  </p>
                </div>
              </div>
            </Card>
          </div>
        </section>

        {/* ── 3. 企业方案咨询卡 ── */}
        <section className="px-4 pb-6">
          <div className="max-w-md mx-auto">
            <Card className="backdrop-blur-xl bg-gradient-to-br from-blue-500/15 to-cyan-500/15 border border-blue-500/40 p-5">
              <h3 className="text-base text-white mb-2">需要结合企业场景评估？</h3>
              <p className="text-xs text-slate-300 leading-relaxed mb-3">
                如果您正在推进企业标准管理、质量合规、安全生产、供应链管理、销售服务或知识库建设，可联系专属顾问进行场景沟通，初步判断适合从哪个业务场景切入。
              </p>
              <div className="flex flex-wrap gap-1.5 mb-4">
                {['需求沟通', '场景诊断', '方案评估'].map((t, i) => (
                  <span key={i} className="text-[10px] text-blue-300 bg-blue-500/20 border border-blue-500/30 px-2.5 py-1 rounded-full">{t}</span>
                ))}
              </div>
              <Button
                onClick={goContact}
                className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 border-0 text-white h-10 font-medium shadow-lg shadow-blue-500/30 active:scale-[0.98] transition-all"
              >
                <MessageCircle className="size-4" />
                咨询企业方案
              </Button>
            </Card>
          </div>
        </section>

        {/* ── 4. 企业最愿意为三件事买单 ── */}
        <section className="px-4 py-8">
          <div className="max-w-md mx-auto">
            <div className="text-center mb-6">
              <h2 className="text-xl text-white mb-1">企业最愿意为三件事买单</h2>
              <p className="text-slate-400 text-xs">稳生产、降成本、促增长，是"用标准"最容易落地的三个方向</p>
            </div>

            <div className="space-y-4">
              {DEAL_LINES.map((line) => {
                const Icon = line.icon
                return (
                  <Card
                    key={line.id}
                    className={`backdrop-blur-xl bg-gradient-to-br ${line.gradient} border ${line.borderColor} p-4`}
                  >
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`shrink-0 size-10 ${line.iconBg} rounded-lg flex items-center justify-center`}>
                        <Icon className="size-5 text-white" />
                      </div>
                      <div>
                        <div className="text-sm text-white">{line.title}</div>
                        <div className="text-xs text-slate-400">{line.subtitle}</div>
                      </div>
                    </div>
                    <p className="text-xs text-slate-300 leading-relaxed mb-3">{line.body}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {line.tags.map((t, i) => (
                        <span key={i} className="text-[10px] text-slate-300 bg-white/10 border border-white/10 px-2.5 py-1 rounded-full">{t}</span>
                      ))}
                    </div>
                  </Card>
                )
              })}
            </div>
          </div>
        </section>

        {/* ── 5. 用标准，解决企业标准落地的四个关键问题 ── */}
        <section className="px-4 py-8">
          <div className="max-w-md mx-auto">
            <div className="text-center mb-6">
              <h2 className="text-xl text-white mb-1">用标准，解决企业标准落地的四个关键问题</h2>
              <p className="text-slate-400 text-xs">标准要求变任务，执行记录入证据库，审计包随时一键导出</p>
            </div>

            <div className="space-y-4">
              {CAPABILITIES.map((cap) => {
                const Icon = cap.icon
                return (
                  <Card
                    key={cap.id}
                    className="backdrop-blur-xl bg-white/5 border border-white/10 hover:bg-white/8 transition-all overflow-hidden relative"
                  >
                    <div className={`absolute inset-0 bg-gradient-to-br ${cap.gradient} opacity-50`}></div>
                    <div className="relative z-10 p-4">
                      <div className="flex items-start gap-3 mb-3">
                        <div className={`shrink-0 size-12 ${cap.iconBg} rounded-xl flex items-center justify-center shadow-lg`}>
                          <Icon className="size-6 text-white" />
                        </div>
                        <div className="flex-1">
                          <h3 className="text-base text-white mb-1">{cap.title}</h3>
                          <p className="text-xs text-slate-400 leading-relaxed">{cap.description}</p>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {cap.features.map((f, i) => (
                          <span key={i} className="text-[10px] text-slate-300 bg-white/10 px-2.5 py-1 rounded-full border border-white/10">{f}</span>
                        ))}
                      </div>
                      <div className="flex items-start gap-2 bg-slate-800/50 border border-slate-700/50 rounded-lg p-2.5">
                        <CheckCircle2 className="size-3.5 text-blue-400 shrink-0 mt-0.5" />
                        <p className="text-[10px] text-slate-400 leading-relaxed">{cap.notice}</p>
                      </div>
                    </div>
                  </Card>
                )
              })}
            </div>
          </div>
        </section>

        {/* ── 6. 适合这些企业场景 ── */}
        <section className="px-4 py-6">
          <div className="max-w-md mx-auto">
            <h2 className="text-lg text-white mb-1 text-center">适合这些企业场景</h2>
            <p className="text-slate-400 text-xs text-center mb-5">从标准管理走向业务应用，覆盖企业经营关键环节</p>
            <div className="flex flex-wrap gap-2 justify-center">
              {SCENARIOS.map((s, i) => (
                <div
                  key={i}
                  className="backdrop-blur-xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all rounded-full px-4 py-2"
                >
                  <span className="text-sm text-slate-200">{s}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ── 7. 底部 CTA ── */}
        <section className="px-4 py-6">
          <div className="max-w-md mx-auto">
            <Card className="backdrop-blur-xl bg-gradient-to-br from-blue-500/10 to-cyan-500/10 border border-blue-500/30 p-6 text-center">
              <h2 className="text-lg text-white mb-3">想让标准变成日常任务、让记录变成可用材料？</h2>
              <p className="text-sm text-slate-300 leading-relaxed mb-4">
                把标准要求库转成员工任务清单，执行记录自动沉淀，投标 / 检查 / 内审 / 验收随时一键出包。
                如果您正在评估企业标准数字化、质量安全合规、供应链管理或销售服务赋能，可联系专属顾问进行场景沟通。
              </p>
              <div className="flex flex-wrap gap-2 justify-center mb-5 text-xs">
                {['场景诊断', '方案沟通', '试点评估', '企业定制'].map((v, i) => (
                  <span key={i} className="bg-white/5 border border-white/10 rounded-full px-3 py-1.5 text-slate-200">{v}</span>
                ))}
              </div>
              <Button
                onClick={goContact}
                className="w-full bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 border-0 text-white h-11 font-semibold shadow-lg shadow-blue-500/40 active:scale-[0.98] transition-all"
              >
                <MessageCircle className="size-4" />
                咨询企业方案
              </Button>
              <p className="text-xs text-slate-500 mt-4 leading-relaxed">
                想先体验基础能力？可进入小程序体验标准查询、AI 问答、标准管理、标准编写与标准监测。
                <button
                  onClick={goBack}
                  className="text-slate-400 underline underline-offset-2 ml-1 hover:text-slate-300"
                >
                  进入小程序体验
                </button>
              </p>
            </Card>
          </div>
        </section>

        {/* 页脚 */}
        <footer className="backdrop-blur-md bg-slate-900/50 border-t border-white/5 py-6 mt-4">
          <div className="max-w-md mx-auto px-4 text-center">
            <div className="text-slate-300 text-sm mb-1">标准小智 · 标准智能平台</div>
            <div className="text-slate-500 text-xs">企业标准数字化与 AI 工具服务</div>
          </div>
        </footer>
      </div>

      {/* 悬浮底栏 */}
      <div className="fixed bottom-0 left-0 right-0 z-50 backdrop-blur-xl bg-slate-900/90 border-t border-white/10 px-4 py-3 safe-area-inset-bottom">
        <div className="max-w-md mx-auto flex gap-3">
          <Button
            onClick={goBack}
            variant="outline"
            className="flex-1 bg-slate-800/60 border-slate-500/40 text-slate-100 hover:bg-slate-700/60 hover:border-slate-400/60 h-11 font-medium active:scale-[0.98] transition-all"
          >
            <ArrowLeft className="size-4" />
            返回
          </Button>
          <Button
            onClick={goContact}
            className="flex-1 bg-gradient-to-r from-blue-600 to-cyan-600 hover:from-blue-500 hover:to-cyan-500 border-0 text-white h-11 font-semibold shadow-lg shadow-blue-500/40 active:scale-[0.98] transition-all"
          >
            <MessageCircle className="size-4" />
            咨询企业方案
          </Button>
        </div>
      </div>
    </div>
  )
}
