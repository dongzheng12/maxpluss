/**
 * 共享销售推广码生成器
 *
 * 8 位大写字母 + 数字（去除 I O 0 1 易混字符），全局唯一。
 * 同时查 SalesProfile.salesCode 和 SalesCode.salesCode 两个表，确保码空间不冲突。
 *
 * 历史：salesRoutes.ts 和 salesV2Routes.ts 各有一份等价实现（其中 salesV2 的 V2 版本是双查严格版）。
 * 本 util 抽取自 salesV2Routes.ts:535 allocateUniqueSalesCodeV2，其余调用方后续可逐步迁过来。
 */
import { prisma } from '../db'

const SALES_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 去 I O 0 1

export function generateSalesCode(length = 8): string {
  let code = ''
  for (let i = 0; i < length; i++) {
    code += SALES_CODE_CHARS[Math.floor(Math.random() * SALES_CODE_CHARS.length)]
  }
  return code
}

/**
 * 生成唯一 salesCode（最多重试 10 次；全部冲突返回 null）。
 * 同时查 SalesProfile.salesCode 和 SalesCode.salesCode 表。
 */
export async function allocateUniqueSalesCode(): Promise<string | null> {
  for (let i = 0; i < 10; i++) {
    const candidate = generateSalesCode(8)
    const [c1, c2] = await Promise.all([
      prisma.salesCode.findUnique({ where: { salesCode: candidate } }),
      prisma.salesProfile.findUnique({ where: { salesCode: candidate } }),
    ])
    if (!c1 && !c2) return candidate
  }
  return null
}
