/**
 * ContentConfig 种子数据
 * 2026-04-26 — CMS 1.0 最小集（13 条）
 *
 * 用法（生产）：
 *   1. 先 sqlite3 .read migration.sql 建表
 *   2. npx ts-node --esm prisma/seed-content-config.ts
 *      或直接把 seedContentConfig() 加到现有 seed 脚本末尾
 */
import { PrismaClient } from '@prisma/client'
import { createId } from '@paralleldrive/cuid2'
import { pathToFileURL } from 'node:url'

const prisma = new PrismaClient()

export const DEFAULT_MEMBERSHIP_BENEFITS_MATRIX = {
  version: 1,
  columns: [
    { key: 'guest', label: '未登录' },
    { key: 'free', label: '免费用户' },
    { key: 'personal', label: '个人会员 ¥598/年' },
    { key: 'pro', label: '专业会员 ¥998/年' },
  ],
  sections: [
    {
      key: 'basic',
      title: '基础功能',
      rows: [
        {
          key: 'standard_search',
          name: '标准信息查询',
          values: {
            guest: '不可用',
            free: '每天 5 次',
            personal: '不限次',
            pro: '不限次',
          },
        },
        {
          key: 'standard_graph',
          name: '知识图谱',
          values: {
            guest: '不可用',
            free: '每天 5 次',
            personal: '不限次',
            pro: '不限次',
          },
        },
        {
          key: 'technical_committee',
          name: '技术委员会查询',
          values: {
            guest: '不可用',
            free: '不限次',
            personal: '不限次',
            pro: '不限次',
          },
        },
      ],
    },
    {
      key: 'chat',
      title: '呼叫小智',
      rows: [
        {
          key: 'chat_assistant',
          name: '呼叫小智 / AI 编写辅助',
          values: {
            guest: '不可用',
            free: '每天 5 次',
            personal: '不限次',
            pro: '不限次',
          },
        },
      ],
    },
    {
      key: 'high_value',
      title: '高价值功能',
      rows: [
        {
          key: 'compare_one_to_one',
          name: '一对一比对（上传两份文档）',
          values: {
            guest: '不可用',
            free: '不可用',
            personal: '不限次',
            pro: '不限次',
          },
        },
        {
          key: 'compare_library',
          name: '全库相似度分析',
          values: {
            guest: '不可用',
            free: '不可用',
            personal: '10 次/年完整报告',
            pro: '不限次完整报告',
          },
        },
      ],
    },
  ],
  noteItems: [
    '免费用户各功能次数独立计算，互不影响。',
    '一对一比对为会员专属功能，需开通个人会员或专业会员方可使用。',
    '全库相似度分析为会员权益，完整报告按会员等级和套餐次数使用。',
    '个人会员的全库相似度分析次数为 10 次/年，自开通日起算；专业会员不限次。',
  ],
} as const

export const DEFAULT_MP_MEMBER_FREE_BENEFITS = [
  '标准信息查询：每天 5 次',
  '知识图谱：每天 5 次',
  '技术委员会查询：不限次',
  '呼叫小智 / AI 编写辅助：每天 5 次',
  '全库相似度分析：会员可用（免费用户不可用）',
] as const

export const DEFAULT_MP_MEMBERSHIP_INFO_NOTICE = '本平台展示的标准信息及 AI 辅助分析内容仅供参考，不代表官方发布内容或正式审查结论；标准的引用、使用及传播，请以官方或授权渠道为准，并遵守相关版权规定。'

export const DEFAULT_MP_COMPARE_MEMBERSHIP_NOTICE = {
  launch: {
    free: '一对一比对与全库相似度分析均为会员权益内功能，按套餐次数消耗，失败不计次。',
    personalRemaining: '个人会员：全库相似度分析剩余 {remaining} 次',
    personalExhausted: '个人会员：本年度全库相似度分析 10 次完整报告额度已用完，可升级专业版',
    pro: '专业会员：全库相似度分析不限次完整报告',
    pairPageLimit: '一对一比对仅分析前 30 页内容，超出部分将跳过',
    pairMemberOnly: '一对一比对为会员专属功能，请升级会员后使用',
  },
  result: {
    free: '全库相似度分析完整报告需开通个人或专业会员，按套餐次数消耗，失败不计次。',
    personalRemaining: '个人会员：全库相似度分析剩余 {remaining} 次',
    personalExhausted: '个人会员：本年度全库相似度分析 10 次完整报告额度已用完，可升级专业版',
    pro: '专业会员：全库相似度分析不限次完整报告',
    reportLocked: '全库相似度分析报告需要会员权限，请开通个人或专业会员',
  },
} as const

export const DEFAULT_MP_PROFILE_LOGIN_HINT = '登录后享受更多权益'
export const DEFAULT_MP_PROFILE_MEMBERSHIP_HINT = '享受公开范围标准在线查看与快捷获取'

const seeds: Array<{
  key: string
  group: string
  platform: string
  type: string
  title?: string
  subtitle?: string
  content?: string
  description?: string
  extraJson?: string
  sortOrder: number
}> = [
  // ── Hero 快捷标签（PC Web 首页）──────────────────────────────
  { key: 'hero_tag_1', group: 'hero_tags', platform: 'WEB', type: 'TEXT', content: '问标准', sortOrder: 1 },
  { key: 'hero_tag_2', group: 'hero_tags', platform: 'WEB', type: 'TEXT', content: '写标准', sortOrder: 2 },
  { key: 'hero_tag_3', group: 'hero_tags', platform: 'WEB', type: 'TEXT', content: '做任务', sortOrder: 3 },
  { key: 'hero_tag_4', group: 'hero_tags', platform: 'WEB', type: 'TEXT', content: '会员服务', sortOrder: 4 },

  // ── 销售顾问默认档案 ──────────────────────────────────────────
  { key: 'sales_default_bio', group: 'sales_profile', platform: 'BOTH', type: 'TEXT', content: '专注为企业提供高质量标准文件服务', sortOrder: 1 },
  { key: 'sales_default_position', group: 'sales_profile', platform: 'BOTH', type: 'TEXT', content: '标准小智销售顾问', sortOrder: 2 },

  // ── 首页数字统计 ──────────────────────────────────────────────
  { key: 'stat_users', group: 'home_stats', platform: 'BOTH', type: 'TEXT', title: '注册用户', content: '10000+', sortOrder: 1 },
  { key: 'stat_docs', group: 'home_stats', platform: 'BOTH', type: 'TEXT', title: '标准文件', content: '50000+', sortOrder: 2 },
  { key: 'stat_accuracy', group: 'home_stats', platform: 'BOTH', type: 'TEXT', title: '准确率', content: '99%', sortOrder: 3 },

  // ── 首页特色卡片 ──────────────────────────────────────────────
  {
    key: 'feature_1_title',
    group: 'home_features',
    platform: 'BOTH',
    type: 'TEXT',
    content: '智能生成',
    sortOrder: 1,
  },
  {
    key: 'feature_1_desc',
    group: 'home_features',
    platform: 'BOTH',
    type: 'TEXT',
    content: '基于AI技术，快速生成标准文件',
    sortOrder: 2,
  },
  {
    key: 'feature_2_title',
    group: 'home_features',
    platform: 'BOTH',
    type: 'TEXT',
    content: '专业审核',
    sortOrder: 3,
  },
  {
    key: 'feature_2_desc',
    group: 'home_features',
    platform: 'BOTH',
    type: 'TEXT',
    content: '专业团队把关，确保文件质量',
    sortOrder: 4,
  },

  // ── 销售推广页 — 标准小智 AI 详情页优惠券 ────────────────────────
  // 单条 JSON：title/subtitle/description/content(amount) + extraJson 装结构化字段
  // 字段含义详见 appRoutes.ts seedSalesAiCoupon()
  {
    key: 'sales_ai_coupon_main',
    group: 'sales_ai_coupon',
    platform: 'WEB',
    type: 'COUPON_CARD',
    title: '专属优惠',
    subtitle: '会员直减券',
    description: '通过销售推广页注册即可获得，可用于购买任意会员套餐',
    content: '50',
    extraJson: JSON.stringify({
      tag: '限时',
      amountPrefix: '¥',
      amountSuffix: '',
      benefits: ['注册即领', '全会员通用', '60 天有效'],
      validityDays: 60,
      scene: 'sales_promotion_ai_detail',
      applicablePlans: ['all'],
      ctaText: '',
      ctaAction: 'none',
    }),
    sortOrder: 1,
  },

  // ============================================================
  // 阶段 0（mp 远程配置底座）— 12 个分组默认 seed
  // /api/app/config 聚合返回，小程序 onLaunch 拉取
  // 运营在 admin 后台改 ContentConfig 后无需发版
  // ============================================================

  // ── mp_copy_home — 首页文案 ───────────────────────────────────
  { key: 'mp_copy_home_hero_title', group: 'mp_copy_home', platform: 'MP', type: 'TEXT', content: '标准查询·智能助手', sortOrder: 1 },
  { key: 'mp_copy_home_hero_subtitle', group: 'mp_copy_home', platform: 'MP', type: 'TEXT', content: 'AI 帮你又快又准地查标准、做任务', sortOrder: 2 },
  { key: 'mp_copy_home_banner_text', group: 'mp_copy_home', platform: 'MP', type: 'TEXT', content: '注册即送会员体验权益', sortOrder: 3 },

  // ── mp_copy_register — 注册页文案 / 价值点 ─────────────────────
  // 与 apps/mp-weixin/pages/register/index.wxml 字面一致 — wxml 为唯一事实源
  { key: 'mp_copy_register_value_1', group: 'mp_copy_register', platform: 'MP', type: 'TEXT', content: 'AI 标准问答，秒出结果', sortOrder: 1 },
  { key: 'mp_copy_register_value_2', group: 'mp_copy_register', platform: 'MP', type: 'TEXT', content: 'AI 文档比对，自动出报告', sortOrder: 2 },
  { key: 'mp_copy_register_value_3', group: 'mp_copy_register', platform: 'MP', type: 'TEXT', content: '商品扫一扫，看看什么值得买', sortOrder: 3 },

  // ── mp_copy_membership — 会员页文案 ────────────────────────────
  // 与 apps/mp-weixin/pages/membership/index.wxml 字面一致 — wxml 为唯一事实源
  { key: 'mp_copy_membership_already_pro_title', group: 'mp_copy_membership', platform: 'MP', type: 'TEXT', content: '您已是专业会员', sortOrder: 1 },
  { key: 'mp_copy_membership_already_pro_desc', group: 'mp_copy_membership', platform: 'MP', type: 'TEXT', content: '当前为最高等级，感谢您的支持', sortOrder: 2 },
  { key: 'mp_copy_membership_upgrade_hint', group: 'mp_copy_membership', platform: 'MP', type: 'TEXT', content: '您当前为个人会员，可升级到专业版（仅需补差价）', sortOrder: 3 },
  { key: 'mp_copy_membership_promo_banner', group: 'mp_copy_membership', platform: 'MP', type: 'TEXT', content: '早鸟优惠进行中', sortOrder: 4 },
  { key: 'mp_copy_membership_promo_tag', group: 'mp_copy_membership', platform: 'MP', type: 'TEXT', content: '限时优惠', sortOrder: 5 },
  { key: 'mp_copy_membership_price_contact', group: 'mp_copy_membership', platform: 'MP', type: 'TEXT', content: '联系销售', sortOrder: 6 },
  { key: 'mp_copy_membership_btn_enterprise', group: 'mp_copy_membership', platform: 'MP', type: 'TEXT', content: '联系销售', sortOrder: 7 },
  { key: 'mp_copy_membership_btn_upgrade', group: 'mp_copy_membership', platform: 'MP', type: 'TEXT', content: '立即升级', sortOrder: 8 },
  { key: 'mp_copy_membership_btn_subscribe', group: 'mp_copy_membership', platform: 'MP', type: 'TEXT', content: '立即开通', sortOrder: 9 },
  { key: 'mp_copy_membership_active_hint', group: 'mp_copy_membership', platform: 'MP', type: 'TEXT', content: '您已是专业会员', sortOrder: 10 },
  { key: 'mp_copy_membership_expired_hint', group: 'mp_copy_membership', platform: 'MP', type: 'TEXT', content: '会员已过期，续费可恢复全部权益', sortOrder: 11 },

  // ── membership — 会员权益对照矩阵（PC / 小程序共用） ────────────
  {
    key: 'membership_benefits_matrix',
    group: 'membership',
    platform: 'BOTH',
    type: 'JSON',
    content: JSON.stringify(DEFAULT_MEMBERSHIP_BENEFITS_MATRIX),
    sortOrder: 1,
  },
  {
    key: 'mp_member_free_benefits',
    group: 'membership',
    platform: 'MP',
    type: 'JSON',
    content: JSON.stringify(DEFAULT_MP_MEMBER_FREE_BENEFITS),
    sortOrder: 2,
  },
  {
    key: 'mp_membership_info_notice',
    group: 'membership',
    platform: 'MP',
    type: 'TEXT',
    content: DEFAULT_MP_MEMBERSHIP_INFO_NOTICE,
    sortOrder: 3,
  },
  {
    key: 'mp_compare_membership_notice',
    group: 'compare',
    platform: 'MP',
    type: 'JSON',
    content: JSON.stringify(DEFAULT_MP_COMPARE_MEMBERSHIP_NOTICE),
    sortOrder: 4,
  },
  {
    key: 'mp_profile_login_hint',
    group: 'profile',
    platform: 'MP',
    type: 'TEXT',
    content: DEFAULT_MP_PROFILE_LOGIN_HINT,
    sortOrder: 5,
  },
  {
    key: 'mp_profile_membership_hint',
    group: 'profile',
    platform: 'MP',
    type: 'TEXT',
    content: DEFAULT_MP_PROFILE_MEMBERSHIP_HINT,
    sortOrder: 6,
  },

  // ── mp_copy_compare — 比对/上传/报告页文案 ─────────────────────
  { key: 'mp_copy_compare_upload_hint', group: 'mp_copy_compare', platform: 'MP', type: 'TEXT', content: '推荐 Word 文档，单文件 ≤20MB', sortOrder: 1 },
  { key: 'mp_copy_compare_pdf_timeout_hint', group: 'mp_copy_compare', platform: 'MP', type: 'TEXT', content: '解析超时建议上传文字版 PDF 或 Word', sortOrder: 2 },
  { key: 'mp_copy_compare_no_text_hint', group: 'mp_copy_compare', platform: 'MP', type: 'TEXT', content: '未识别到文本内容，请确认文档非扫描件', sortOrder: 3 },

  // ── mp_copy_status — 任务/订单/预约 状态文案映射 ────────────────
  { key: 'mp_copy_status_task_processing', group: 'mp_copy_status', platform: 'MP', type: 'TEXT', content: '处理中', sortOrder: 1 },
  { key: 'mp_copy_status_task_completed', group: 'mp_copy_status', platform: 'MP', type: 'TEXT', content: '已完成', sortOrder: 2 },
  { key: 'mp_copy_status_task_failed', group: 'mp_copy_status', platform: 'MP', type: 'TEXT', content: '失败', sortOrder: 3 },
  { key: 'mp_copy_status_order_paid', group: 'mp_copy_status', platform: 'MP', type: 'TEXT', content: '已支付', sortOrder: 4 },
  { key: 'mp_copy_status_order_unpaid', group: 'mp_copy_status', platform: 'MP', type: 'TEXT', content: '待支付', sortOrder: 5 },
  { key: 'mp_copy_status_booking_pending', group: 'mp_copy_status', platform: 'MP', type: 'TEXT', content: '待确认', sortOrder: 6 },

  // ── contact — 客服 / 联系方式 ─────────────────────────────────
  { key: 'contact_email', group: 'contact', platform: 'BOTH', type: 'TEXT', content: 'biaozhunxiaozhi@tbzy.org.cn', sortOrder: 1 },
  { key: 'contact_phone', group: 'contact', platform: 'BOTH', type: 'TEXT', content: '', sortOrder: 2 },
  { key: 'contact_qrcode_url', group: 'contact', platform: 'BOTH', type: 'IMAGE_URL', content: '', sortOrder: 3 },
  { key: 'contact_help_url', group: 'contact', platform: 'BOTH', type: 'TEXT', content: '', sortOrder: 4 },

  // ── share_text — 分享标题 / 朋友圈 ────────────────────────────
  // 与 apps/mp-weixin/pages/report/index.js onShareAppMessage / onShareTimeline 字面一致
  { key: 'share_default_title', group: 'share_text', platform: 'MP', type: 'TEXT', content: '标准小智 · 标准比对工具', sortOrder: 1 },
  { key: 'share_default_desc', group: 'share_text', platform: 'MP', type: 'TEXT', content: 'AI 标准查询、文档比对、扫一扫识别', sortOrder: 2 },
  { key: 'share_report_title_prefix', group: 'share_text', platform: 'MP', type: 'TEXT', content: '我的标准比对报告', sortOrder: 3 },
  { key: 'share_report_fallback_doc_name', group: 'share_text', platform: 'MP', type: 'TEXT', content: '风险提示报告', sortOrder: 4 },
  { key: 'share_timeline_default_title', group: 'share_text', platform: 'MP', type: 'TEXT', content: '标准小智 · 标准比对工具', sortOrder: 5 },
  { key: 'share_timeline_report_title', group: 'share_text', platform: 'MP', type: 'TEXT', content: '标准小智 · 比对报告', sortOrder: 6 },

  // ── demo_committees — Demo 销售演示数据：技术委员会 ──────────────
  { key: 'demo_committee_1', group: 'demo_committees', platform: 'MP', type: 'TEXT', content: '全国信息技术标准化技术委员会', sortOrder: 1 },
  { key: 'demo_committee_2', group: 'demo_committees', platform: 'MP', type: 'TEXT', content: '全国食品工业标准化技术委员会', sortOrder: 2 },
  { key: 'demo_committee_3', group: 'demo_committees', platform: 'MP', type: 'TEXT', content: '全国质量管理和质量保证标准化技术委员会', sortOrder: 3 },

  // ── demo_industries — Demo 销售演示数据：行业组 ─────────────────
  { key: 'demo_industry_1', group: 'demo_industries', platform: 'MP', type: 'TEXT', content: '智能制造', sortOrder: 1 },
  { key: 'demo_industry_2', group: 'demo_industries', platform: 'MP', type: 'TEXT', content: '食品安全', sortOrder: 2 },
  { key: 'demo_industry_3', group: 'demo_industries', platform: 'MP', type: 'TEXT', content: '建筑工程', sortOrder: 3 },

  // ── booking_options — 预约服务选项 ────────────────────────────
  { key: 'booking_service_type_1', group: 'booking_options', platform: 'MP', type: 'TEXT', content: '产品试用开通', sortOrder: 1 },
  { key: 'booking_service_type_2', group: 'booking_options', platform: 'MP', type: 'TEXT', content: '功能演示培训', sortOrder: 2 },
  { key: 'booking_service_type_3', group: 'booking_options', platform: 'MP', type: 'TEXT', content: '采购与方案对接', sortOrder: 3 },
  { key: 'booking_flow_step_1', group: 'booking_options', platform: 'MP', type: 'TEXT', content: '提交预约 → 销售联系 → 安排时间 → 服务交付', sortOrder: 4 },

  // ── feature_flags_default — feature-flags 接口 default seed ──
  // 单条 KEY 落 SystemSetting，但留一份说明在 ContentConfig 方便 admin 看到默认值
  // /api/app/feature-flags 接口实际从 SystemSetting key=feature_flags 读
  { key: 'feature_flags_doc', group: 'feature_flags_default', platform: 'BOTH', type: 'TEXT',
    content: 'feature-flags 接口数据源是 SystemSetting key=feature_flags（单条 JSON）。本条目仅作管理后台 UI 文档用。',
    sortOrder: 1 },

  // ── pay_config — 支付页提示 / 收据兜底文案 ────────────────────
  { key: 'pay_config_entry_disabled_text', group: 'pay_config', platform: 'MP', type: 'TEXT', content: '支付通道暂不可用，请稍后再试', sortOrder: 1 },
  { key: 'pay_config_receipt_unavailable_text', group: 'pay_config', platform: 'MP', type: 'TEXT', content: '电子收据生成中，请稍候在订单详情查看', sortOrder: 2 },
]

export async function seedContentConfig() {
  console.log('[seed-content-config] 写入种子数据...')
  let created = 0
  let skipped = 0

  for (const seed of seeds) {
    const existing = await (prisma as any).contentConfig.findUnique({ where: { key: seed.key } })
    if (existing) {
      skipped++
      continue
    }
    await (prisma as any).contentConfig.create({
      data: {
        id: createId(),
        enabled: true,
        ...seed,
      },
    })
    created++
  }

  console.log(`[seed-content-config] 完成：新建 ${created} 条，跳过 ${skipped} 条`)
}

// esbuild --bundle 会把本文件内联进 dist/server.mjs。
// 仅 import.meta.url === pathToFileURL(process.argv[1]).href 不够：
// bundle 后 server.mjs 里这个等式也成立 (import.meta.url 跟随宿主),
// 会触发 top-level seedContentConfig() 与 ensureAppSeed→seedMpRemoteConfigGroups
// 并发写同 key → PG 下 race 触发 P2002。补一条 argv[1] 路径关键字硬约束，
// 仅当 ts-node/tsx 直接执行本文件路径时才自动跑。
const isDirectRun =
  typeof process !== 'undefined' &&
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[1].includes('seed-content-config')

// 直接执行时运行
if (isDirectRun) {
  seedContentConfig()
    .catch((e) => { console.error(e); process.exit(1) })
    .finally(() => prisma.$disconnect())
}
