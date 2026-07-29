/**
 * 内置 AdminRole 管理（v3 §4）
 *
 * 当前仅一个内置角色："销售"。
 * isSystem=true 标记。
 *
 * 两处时机 ensure：
 *   1. 启动时 ensureAppSeed 自动 ensure（Step 3）
 *   2. set-sales 接口按需 ensure（兜底，避免依赖启动时机）
 *
 * upsert by name：已存在则不动（运营 UI 改过的菜单/操作权限不被覆盖）
 */
import type { AdminRole } from '@prisma/client'
import { prisma } from '../db'

export const SALES_BUILT_IN_ROLE_NAME = '销售'
export const SALES_CORE_MENU_PATH = '/admin/sales/workspace'

export async function ensureSalesBuiltInRole(createdBy: string = 'system'): Promise<AdminRole> {
  return prisma.adminRole.upsert({
    where: { name: SALES_BUILT_IN_ROLE_NAME },
    update: {}, // 已存在不动 — 运营改过的不被覆盖
    create: {
      name: SALES_BUILT_IN_ROLE_NAME,
      description: '系统内置：销售工作台访问',
      menuPermissions: [SALES_CORE_MENU_PATH],
      actionPermissions: [],
      dataScope: 'SELF',
      isSystem: true,
      status: 'ACTIVE',
      createdBy,
    },
  })
}

/** 启动时 ensure 所有内置角色 */
export async function ensureBuiltInRoles(createdBy: string = 'system'): Promise<void> {
  await ensureSalesBuiltInRole(createdBy)
}
