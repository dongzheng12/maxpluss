/**
 * 阶段 0 — /api/app/config 聚合接口测试
 *
 * 覆盖：
 *  - 默认 seed 注入 12 分组后，接口返回 copy/contact/share/flags/appMinVersion 五块结构
 *  - copy 按 page 分组：mp_copy_home → copy.home.<key>
 *  - contact / share 直接落到对应 bucket
 *  - flags 合并 SystemSetting JSON + env 级 couponEnabled
 *  - SystemSetting key=feature_flags 改 → 接口跟随
 *  - SystemSetting key=mp_min_version 改 → appMinVersion 跟随
 *  - ContentConfig enabled=false → 接口不返回
 *  - 即便所有数据缺失，接口也返回 200 + 空结构（不抛错）
 *  - Cache-Control header 正确
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { prisma } from '../src/db.js'
import { registerAppRoutes, ensureAppSeed } from '../src/appRoutes.js'
import { ensurePlans } from './factory.js'
import {
  DEFAULT_MEMBERSHIP_BENEFITS_MATRIX,
  DEFAULT_MP_COMPARE_MEMBERSHIP_NOTICE,
  DEFAULT_MP_MEMBER_FREE_BENEFITS,
  DEFAULT_MP_MEMBERSHIP_INFO_NOTICE,
  DEFAULT_MP_PROFILE_LOGIN_HINT,
  DEFAULT_MP_PROFILE_MEMBERSHIP_HINT,
} from '../prisma/seed-content-config.js'

const app = express()
app.use(express.json())

beforeAll(async () => {
  await ensurePlans()
  registerAppRoutes(app)
  await ensureAppSeed()
})

describe('GET /api/app/config — 阶段 0 聚合接口', () => {
  it('默认 seed 后返回完整结构（copy / contact / share / flags / appMinVersion / version）', async () => {
    const res = await request(app).get('/api/app/config')
    expect(res.status).toBe(200)
    expect(res.body).toHaveProperty('copy')
    expect(res.body).toHaveProperty('contact')
    expect(res.body).toHaveProperty('share')
    expect(res.body).toHaveProperty('flags')
    expect(res.body).toHaveProperty('appMinVersion')
    expect(res.body).toHaveProperty('version')
    expect(res.body).toHaveProperty('membershipBenefitsMatrix')
    expect(res.body).toHaveProperty('memberFreeBenefits')
    expect(res.body).toHaveProperty('membershipInfoNotice')
    expect(res.body).toHaveProperty('compareMembershipNotice')
    expect(res.body).toHaveProperty('profileLoginHint')
    expect(res.body).toHaveProperty('profileMembershipHint')
    expect(typeof res.body.version).toBe('number')
  })

  it('membership_benefits_matrix 合法 JSON → 返回结构化对象', async () => {
    const res = await request(app).get('/api/app/config')
    expect(res.body.membershipBenefitsMatrix).toEqual(DEFAULT_MEMBERSHIP_BENEFITS_MATRIX)
    expect(res.body.membershipBenefitsMatrix.sections).toHaveLength(3)
    expect(res.body.membershipBenefitsMatrix.noteItems).toHaveLength(4)
    expect(res.body.memberFreeBenefits).toEqual(DEFAULT_MP_MEMBER_FREE_BENEFITS)
    expect(res.body.membershipInfoNotice).toBe(DEFAULT_MP_MEMBERSHIP_INFO_NOTICE)
    expect(res.body.compareMembershipNotice).toEqual(DEFAULT_MP_COMPARE_MEMBERSHIP_NOTICE)
    expect(res.body.profileLoginHint).toBe(DEFAULT_MP_PROFILE_LOGIN_HINT)
    expect(res.body.profileMembershipHint).toBe(DEFAULT_MP_PROFILE_MEMBERSHIP_HINT)
  })

  it('membership_benefits_matrix 非法 JSON → 不返回该字段，且不影响原有字段', async () => {
    await prisma.contentConfig.update({
      where: { key: 'membership_benefits_matrix' },
      data: { content: '{invalid json' },
    })
    const res = await request(app).get('/api/app/config')
    expect(res.status).toBe(200)
    expect(res.body.membershipBenefitsMatrix).toBeUndefined()
    expect(res.body).toHaveProperty('copy')
    expect(res.body).toHaveProperty('contact')
    expect(res.body).toHaveProperty('share')
    expect(res.body).toHaveProperty('flags')

    await prisma.contentConfig.update({
      where: { key: 'membership_benefits_matrix' },
      data: { content: JSON.stringify(DEFAULT_MEMBERSHIP_BENEFITS_MATRIX) },
    })
  })

  it('mp_compare_membership_notice 非法 JSON → 不返回该字段，且不影响原有字段', async () => {
    await prisma.contentConfig.update({
      where: { key: 'mp_compare_membership_notice' },
      data: { content: '{invalid json' },
    })
    const res = await request(app).get('/api/app/config')
    expect(res.status).toBe(200)
    expect(res.body.compareMembershipNotice).toBeUndefined()
    expect(res.body).toHaveProperty('membershipBenefitsMatrix')
    expect(res.body).toHaveProperty('copy')
    expect(res.body).toHaveProperty('flags')

    await prisma.contentConfig.update({
      where: { key: 'mp_compare_membership_notice' },
      data: { content: JSON.stringify(DEFAULT_MP_COMPARE_MEMBERSHIP_NOTICE) },
    })
  })

  it('copy 按 page 分组（mp_copy_home → copy.home）', async () => {
    const res = await request(app).get('/api/app/config')
    expect(res.body.copy).toHaveProperty('home')
    expect(res.body.copy).toHaveProperty('register')
    expect(res.body.copy).toHaveProperty('membership')
    expect(res.body.copy).toHaveProperty('compare')
    expect(res.body.copy).toHaveProperty('status')
    expect(typeof res.body.copy.home.mp_copy_home_hero_title).toBe('string')
    expect(res.body.copy.home.mp_copy_home_hero_title.length).toBeGreaterThan(0)
  })

  it('contact / share 落到对应 bucket', async () => {
    const res = await request(app).get('/api/app/config')
    expect(res.body.contact).toHaveProperty('contact_email')
    expect(res.body.contact.contact_email).toMatch(/@/)
    expect(res.body.share).toHaveProperty('share_default_title')
    expect(res.body.share.share_default_title).toContain('标准')
  })

  it('flags 合并 env couponEnabled', async () => {
    const res = await request(app).get('/api/app/config')
    expect(res.body.flags).toHaveProperty('couponEnabled')
    expect(typeof res.body.flags.couponEnabled).toBe('boolean')
  })

  it('SystemSetting feature_flags 改 → 接口跟随', async () => {
    await prisma.systemSetting.upsert({
      where: { key: 'feature_flags' },
      update: { value: JSON.stringify({ scanV2Enabled: true, paymentJsapi: false }) },
      create: { key: 'feature_flags', value: JSON.stringify({ scanV2Enabled: true, paymentJsapi: false }) },
    })
    const res = await request(app).get('/api/app/config')
    expect(res.body.flags.scanV2Enabled).toBe(true)
    expect(res.body.flags.paymentJsapi).toBe(false)
    // env couponEnabled 仍合并进来
    expect(res.body.flags).toHaveProperty('couponEnabled')

    await prisma.systemSetting.delete({ where: { key: 'feature_flags' } }).catch(() => null)
  })

  it('SystemSetting mp_min_version 改 → appMinVersion 跟随', async () => {
    await prisma.systemSetting.upsert({
      where: { key: 'mp_min_version' },
      update: { value: '1.2.3' },
      create: { key: 'mp_min_version', value: '1.2.3' },
    })
    const res = await request(app).get('/api/app/config')
    expect(res.body.appMinVersion).toBe('1.2.3')
    await prisma.systemSetting.delete({ where: { key: 'mp_min_version' } }).catch(() => null)
  })

  it('ContentConfig enabled=false → 不返回', async () => {
    await prisma.contentConfig.update({
      where: { key: 'mp_copy_home_hero_title' },
      data: { enabled: false },
    })
    const res = await request(app).get('/api/app/config')
    expect(res.body.copy.home?.mp_copy_home_hero_title).toBeUndefined()
    // 恢复
    await prisma.contentConfig.update({
      where: { key: 'mp_copy_home_hero_title' },
      data: { enabled: true },
    })
  })

  it('Cache-Control: public, max-age=300', async () => {
    const res = await request(app).get('/api/app/config')
    expect(res.headers['cache-control']).toMatch(/public.*max-age=300/)
  })

  // ─── 提审一致性守卫（C2）────────────────────────────────────
  // wxml 是唯一事实源。任何人改 seed 内容前必须先改对应 wxml；
  // 本用例直接锁住关键 key 的字面值，防止远程配置接口下发后用户看到与提审版本不一致的文案
  it('register 价值点 / membership 关键文案 / share 文案 与 wxml 字面一致', async () => {
    const res = await request(app).get('/api/app/config')
    // register 价值点（销售推广文案 — 不允许被私自改写）
    expect(res.body.copy.register.mp_copy_register_value_1).toBe('AI 标准问答，秒出结果')
    expect(res.body.copy.register.mp_copy_register_value_2).toBe('AI 文档比对，自动出报告')
    expect(res.body.copy.register.mp_copy_register_value_3).toBe('商品扫一扫，看看什么值得买')
    // membership 文案
    expect(res.body.copy.membership.mp_copy_membership_already_pro_title).toBe('您已是专业会员')
    expect(res.body.copy.membership.mp_copy_membership_already_pro_desc).toBe('当前为最高等级，感谢您的支持')
    expect(res.body.copy.membership.mp_copy_membership_upgrade_hint).toBe('您当前为个人会员，可升级到专业版（仅需补差价）')
    expect(res.body.copy.membership.mp_copy_membership_promo_banner).toBe('早鸟优惠进行中')
    expect(res.body.copy.membership.mp_copy_membership_promo_tag).toBe('限时优惠')
    expect(res.body.copy.membership.mp_copy_membership_btn_enterprise).toBe('联系销售')
    expect(res.body.copy.membership.mp_copy_membership_btn_upgrade).toBe('立即升级')
    expect(res.body.copy.membership.mp_copy_membership_btn_subscribe).toBe('立即开通')
    // share 文案（report 页 onShareAppMessage / onShareTimeline 一致）
    expect(res.body.share.share_default_title).toBe('标准小智 · 标准比对工具')
    expect(res.body.share.share_report_title_prefix).toBe('我的标准比对报告')
    expect(res.body.share.share_timeline_default_title).toBe('标准小智 · 标准比对工具')
    expect(res.body.share.share_timeline_report_title).toBe('标准小智 · 比对报告')
  })
})
