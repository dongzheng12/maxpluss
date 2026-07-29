/**
 * 阶段 0（mp 远程配置底座）— ContentConfig 12 分组默认 seed
 *
 * 数据流：
 *   1. ensureAppSeed() 调用 seedMpRemoteConfigGroups()，启动时 upsert 注入兜底默认值
 *   2. update:{} —— 已存在条目不动，运营在 admin 后台改的内容不被发版覆盖
 *   3. 公开接口 /api/app/config 聚合返回，小程序 onLaunch 拉取
 *
 * 与 prisma/seed-content-config.ts 的关系：
 *   - 后者是独立 ts-node 入口（npx ts-node 直接执行场景），import 即自动跑
 *   - 本文件提供 ensureAppSeed 内部调用的同名 seed 数据，结构保持一致
 *   - 两处都改时务必同步，否则启动后状态分裂
 */
import {
  DEFAULT_MEMBERSHIP_BENEFITS_MATRIX,
  DEFAULT_MP_COMPARE_MEMBERSHIP_NOTICE,
  DEFAULT_MP_MEMBER_FREE_BENEFITS,
  DEFAULT_MP_MEMBERSHIP_INFO_NOTICE,
  DEFAULT_MP_PROFILE_LOGIN_HINT,
  DEFAULT_MP_PROFILE_MEMBERSHIP_HINT,
} from '../../prisma/seed-content-config.js'

type SeedRow = {
  key: string
  group: string
  platform: 'MP' | 'WEB' | 'BOTH'
  type: string
  title?: string
  subtitle?: string
  content?: string
  description?: string
  extraJson?: string
  sortOrder: number
}

export const MP_REMOTE_CONFIG_SEEDS: SeedRow[] = [
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

  // ── membership — 会员权益对照矩阵 / 小程序会员页纯文案 ──────────
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

  // ── feature_flags_default — admin UI 文档（实际数据走 SystemSetting）─
  { key: 'feature_flags_doc', group: 'feature_flags_default', platform: 'BOTH', type: 'TEXT',
    content: 'feature-flags 接口数据源是 SystemSetting key=feature_flags（单条 JSON）。本条目仅作管理后台 UI 文档用。',
    sortOrder: 1 },

  // ── pay_config — 支付页提示 / 收据兜底文案 ────────────────────
  { key: 'pay_config_entry_disabled_text', group: 'pay_config', platform: 'MP', type: 'TEXT', content: '支付通道暂不可用，请稍后再试', sortOrder: 1 },
  { key: 'pay_config_receipt_unavailable_text', group: 'pay_config', platform: 'MP', type: 'TEXT', content: '电子收据生成中，请稍候在订单详情查看', sortOrder: 2 },
]

/**
 * 批量 upsert 12 分组默认 seed。
 * update:{} —— 已存在不动，运营在 admin 后台改的内容不被发版覆盖。
 */
export async function seedMpRemoteConfigGroups(prisma: any): Promise<void> {
  for (const s of MP_REMOTE_CONFIG_SEEDS) {
    await prisma.contentConfig.upsert({
      where: { key: s.key },
      update: {},
      create: {
        key: s.key,
        group: s.group,
        platform: s.platform,
        type: s.type,
        title: s.title,
        subtitle: s.subtitle,
        content: s.content,
        description: s.description,
        extraJson: s.extraJson,
        sortOrder: s.sortOrder,
        enabled: true,
      },
    })
  }
}
