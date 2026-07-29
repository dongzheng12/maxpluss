/**
 * CMS 展示内容管理 — 数据访问层
 * 2026-04-26
 *
 * 仅做简单的 DB 读写，无业务逻辑。
 * 路由层（appRoutes.ts）负责鉴权与参数校验。
 */
import { prisma } from '../db.js'

/** 按 key 取单条（含 disabled 项） */
export async function getContentConfig(key: string) {
  return (prisma as any).contentConfig.findUnique({ where: { key } })
}

/** 按 group 取所有启用项，按 sortOrder ASC 排列 */
export async function getContentConfigGroup(group: string) {
  return (prisma as any).contentConfig.findMany({
    where: { group, enabled: true },
    orderBy: { sortOrder: 'asc' },
  })
}

/** 取全部条目（管理接口用） */
export async function getAllContentConfigs() {
  return (prisma as any).contentConfig.findMany({
    orderBy: [{ group: 'asc' }, { sortOrder: 'asc' }],
  })
}

/** 更新单条（value 字段映射到 content，同时允许更新 enabled / sortOrder / title） */
export async function updateContentConfig(
  key: string,
  patch: {
    content?: string
    title?: string
    subtitle?: string
    description?: string
    enabled?: boolean
    sortOrder?: number
    remark?: string
  },
) {
  return (prisma as any).contentConfig.update({
    where: { key },
    data: patch,
  })
}
