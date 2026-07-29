/**
 * 手机号批量解析 → 已注册 AppUser 匹配
 *
 * 用途：批量分配角色 / 批量发券 等管理后台批量操作的统一入口。
 *
 * 解析规则：
 *   - 输入支持多行、逗号、空格、分号、Tab 任意分隔
 *   - 自动去重（保持首次出现顺序）
 *   - 仅 11 位中国手机号格式（1[3-9]\d{9}）
 *   - 上限 100 个，超限抛错
 *
 * 匹配规则：
 *   - 仅匹配 AppUser 表已存在记录
 *   - 未注册手机号进 notFound（不自动创建）
 */
import { prisma } from '../db'

export const PHONE_BATCH_LIMIT = 100
const PHONE_REGEX = /^1[3-9]\d{9}$/

export interface PhoneResolveResult {
  found: Array<{ id: string; phone: string; name: string | null }>
  notFound: string[]
  invalid: string[]      // 格式不合法（不计入 notFound）
  totalParsed: number    // 去重 + 校验后的总数
}

export class PhoneBatchLimitError extends Error {
  constructor(public limit: number, public actual: number) {
    super(`手机号数量超限（最多 ${limit} 个，实际 ${actual} 个）`)
    this.name = 'PhoneBatchLimitError'
  }
}

/** 把多行/分隔符混杂的输入拆成单行手机号字符串数组（未校验合法性） */
export function parsePhoneInput(raw: string): string[] {
  if (!raw) return []
  return raw
    .split(/[\s,;\t\n\r]+/)
    .map(s => s.trim())
    .filter(Boolean)
}

/**
 * 主入口：把 phones 输入解析 + 去重 + 校验 + 匹配 AppUser
 *
 * @param input 已拆好的 phone 数组,或单一字符串(内部会拆分)
 * @throws PhoneBatchLimitError 当数量超 PHONE_BATCH_LIMIT
 */
export async function phonesToUsers(
  input: string | string[],
): Promise<PhoneResolveResult> {
  const raw = Array.isArray(input) ? input : parsePhoneInput(input)

  // 去重（保持首次出现顺序）
  const seen = new Set<string>()
  const dedupAll: string[] = []
  for (const p of raw) {
    if (!seen.has(p)) {
      seen.add(p)
      dedupAll.push(p)
    }
  }

  if (dedupAll.length > PHONE_BATCH_LIMIT) {
    throw new PhoneBatchLimitError(PHONE_BATCH_LIMIT, dedupAll.length)
  }

  // 拆 valid / invalid
  const valid: string[] = []
  const invalid: string[] = []
  for (const p of dedupAll) {
    if (PHONE_REGEX.test(p)) valid.push(p)
    else invalid.push(p)
  }

  if (valid.length === 0) {
    return { found: [], notFound: [], invalid, totalParsed: dedupAll.length }
  }

  // 一次 IN 查 DB
  const users = await prisma.appUser.findMany({
    where: { phone: { in: valid } },
    select: { id: true, phone: true, name: true },
  })

  const userByPhone = new Map<string, typeof users[number]>()
  for (const u of users) {
    if (u.phone) userByPhone.set(u.phone, u)
  }

  const found: PhoneResolveResult['found'] = []
  const notFound: string[] = []
  for (const p of valid) {
    const u = userByPhone.get(p)
    if (u) found.push({ id: u.id, phone: p, name: u.name })
    else notFound.push(p)
  }

  return { found, notFound, invalid, totalParsed: dedupAll.length }
}
