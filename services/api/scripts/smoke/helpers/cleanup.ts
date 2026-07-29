/**
 * 测试数据清理（统一走 HTTP，绝不直连 prisma）
 *
 * 防止两类问题：
 *   1. 本地能直连 prisma，但 preprod 数据库在公司服务器内网，本地脚本连不上
 *   2. 直连绕过后端校验，可能误删
 *
 * 清理策略：列出资源 → 按 prefix 过滤 → 调对应 DELETE/PATCH 接口逐个删
 */
import type { HttpClient, SmokeEnv } from '../types'
import { isOurPrefix } from './prefix'

export interface CleanupReport {
  rolesDeleted: number
  roleAssignmentsCleared: number
  errors: string[]
}

/**
 * 清理本次 smoke 运行的 SMOKE_<ENV>_<ts>_ 前缀资源。
 *
 * 当前覆盖：
 *   - AdminRole（带 prefix 的）
 *     - 删之前先把它从所有 user 身上撤掉（PATCH /staff/:id/roles roleIds: 剩余）
 *     - 然后 DELETE /api/admin/roles/:id
 *
 * 未来补：
 *   - 测试订单（按 orderNo 前缀，待订单接口支持过滤）
 *   - 临时 SalesProfile（本期不创建，无须清理）
 */
export async function cleanupBySmokePrefix(
  env: SmokeEnv,
  adminClient: HttpClient,
): Promise<CleanupReport> {
  const report: CleanupReport = { rolesDeleted: 0, roleAssignmentsCleared: 0, errors: [] }

  // prod 永远不清
  if (env.env === 'prod') return report

  // 1) 列角色，过滤本次 prefix
  const rolesRes = await adminClient.get<{ items: Array<{ id: string; name: string; userCount: number }> }>(
    '/api/admin/roles'
  )
  if (!rolesRes.ok) {
    report.errors.push(`列角色失败: ${rolesRes.status}`)
    return report
  }
  const ourRoles = (rolesRes.body.items || []).filter((r) => isOurPrefix(env, r.name))

  // 2) 列管理人员，先把 ourRoles 从所有人身上撤掉（保留其它角色）
  if (ourRoles.length > 0) {
    const ourRoleIds = new Set(ourRoles.map((r) => r.id))
    const staffRes = await adminClient.get<{ items: Array<{ id: string; adminRoles: Array<{ id: string }> }> }>(
      '/api/admin/staff'
    )
    if (staffRes.ok) {
      for (const s of staffRes.body.items || []) {
        const remaining = (s.adminRoles || []).filter((ar) => !ourRoleIds.has(ar.id)).map((ar) => ar.id)
        const hasOurs = (s.adminRoles || []).some((ar) => ourRoleIds.has(ar.id))
        if (!hasOurs) continue
        const patch = await adminClient.patch(`/api/admin/staff/${s.id}/roles`, { roleIds: remaining })
        if (!patch.ok) {
          report.errors.push(`撤销角色失败 staff=${s.id}: ${patch.status}`)
        } else {
          report.roleAssignmentsCleared += 1
        }
      }
    } else {
      report.errors.push(`列管理人员失败: ${staffRes.status}`)
    }
  }

  // 3) 删角色
  for (const r of ourRoles) {
    const del = await adminClient.delete(`/api/admin/roles/${r.id}`)
    if (!del.ok) {
      report.errors.push(`删除角色失败 ${r.name}: ${del.status} ${JSON.stringify(del.body).slice(0, 100)}`)
    } else {
      report.rolesDeleted += 1
    }
  }

  return report
}
