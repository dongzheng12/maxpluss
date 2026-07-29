/**
 * 销售身份统一初始化服务
 *
 * 给已注册用户建立销售档案 + 主推码，幂等。
 *
 * 三处调用点（v3 §3）：
 *   1. POST /api/admin/staff/:id/set-sales（管理后台分配销售身份）
 *   2. salesV2Routes 邀请码接受成为销售
 *   3. salesRoutes / appRoutes 销售工作台兜底（用户已分配销售角色但 SalesProfile 还没建）
 *
 * 不动 AppUser.role；不删任何历史数据；不影响订单/会员/优惠券。
 */
import type { Prisma, PrismaClient, SalesProfile } from '@prisma/client'
import { prisma } from '../db'
import { allocateUniqueSalesCode } from '../utils/salesCode'

export interface EnsureSalesProfileResult {
  profile: SalesProfile
  primaryCode: string
  created: boolean // true=新建档案；false=已存在
  primaryCodeCreated: boolean // true=补建主推码；false=已存在
}

export interface EnsureSalesProfileOptions {
  realName?: string
  companyName?: string
  /**
   * 推广主页发布开关（仅新建 SalesProfile 时生效;已存在档案不会被覆盖）。
   * - 不传 → 走 schema 默认 true
   * - 批量分配场景应传 false,让销售自己进推广资料页确认信息后手动启用,
   *   避免空档案直接公开导致访客看到无头像/空 bio 的销售落地页
   */
  isPublic?: boolean
}

type Tx = Prisma.TransactionClient | PrismaClient

async function findPrimaryCode(tx: Tx, profileId: string): Promise<string | null> {
  // 主推码定义：label='主码' 且 status='ACTIVE'
  const code = await tx.salesCode.findFirst({
    where: { profileId, label: '主码', status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
  })
  return code?.salesCode ?? null
}

/**
 * 幂等：保证用户拥有 SalesProfile + 主推码。
 *
 * @throws Error 当用户不存在
 */
export async function ensureSalesProfileAndPrimaryCode(
  userId: string,
  opts: EnsureSalesProfileOptions = {},
): Promise<EnsureSalesProfileResult> {
  const user = await prisma.appUser.findUnique({ where: { id: userId } })
  if (!user) {
    throw new Error(`用户不存在: ${userId}`)
  }

  // 已有档案 → 仅检查主推码
  const existing = await prisma.salesProfile.findUnique({ where: { userId } })
  if (existing) {
    const primaryFromExisting = existing.salesCode
    const primaryFromCode = await findPrimaryCode(prisma, existing.id)
    if (primaryFromCode) {
      return {
        profile: existing,
        primaryCode: primaryFromCode,
        created: false,
        primaryCodeCreated: false,
      }
    }
    // 档案有 salesCode 但 SalesCode 表里没主码 → 补建（用 profile.salesCode）
    await prisma.salesCode.create({
      data: {
        salesCode: primaryFromExisting,
        profileId: existing.id,
        label: '主码',
        status: 'ACTIVE',
      },
    })
    return {
      profile: existing,
      primaryCode: primaryFromExisting,
      created: false,
      primaryCodeCreated: true,
    }
  }

  // 全新创建：事务内 ensure 唯一码 + 创建 Profile + 创建主码
  const newCode = await allocateUniqueSalesCode()
  if (!newCode) {
    throw new Error('生成销售推广码失败（10 次重试均冲突），请重试')
  }
  const realName = opts.realName?.trim() || user.name || '销售'
  const result = await prisma.$transaction(async (tx) => {
    const profile = await tx.salesProfile.create({
      data: {
        salesCode: newCode,
        userId,
        realName,
        companyName: opts.companyName?.trim() || null,
        // isPublic 不传则用 schema 默认 true;批量分配场景显式传 false
        ...(opts.isPublic !== undefined ? { isPublic: opts.isPublic } : {}),
      },
    })
    await tx.salesCode.create({
      data: {
        salesCode: newCode,
        profileId: profile.id,
        label: '主码',
        status: 'ACTIVE',
      },
    })
    return profile
  })
  return {
    profile: result,
    primaryCode: newCode,
    created: true,
    primaryCodeCreated: true,
  }
}
