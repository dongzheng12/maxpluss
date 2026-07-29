/**
 * AuditLog 写入辅助 — 会员/赠送码等敏感操作的审计轨迹
 *
 * 原则：写失败不影响主流程。任何异常吞掉只打日志。
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from '../db.js'
import { logger } from '../logger.js'

type TxClient = Prisma.TransactionClient | PrismaClient

export type AuditAction =
  | 'GIFT_CREATED'
  | 'GIFT_CLAIMED'
  | 'GIFT_REVOKED'
  | 'MEMBERSHIP_CREATED'
  | 'MEMBERSHIP_REVOKED'
  | 'ORDER_REFUND'

export interface AuditLogInput {
  actor?: string | null
  action: AuditAction
  targetType: string
  targetId?: string | null
  diff?: Record<string, unknown>
}

/**
 * 写一条 AuditLog。失败静默（打 warn 日志），绝不抛给调用方。
 * 可选传 tx（事务客户端），用于需要原子性的场景；不传则走默认 prisma。
 */
export async function writeAuditLog(input: AuditLogInput, tx?: TxClient): Promise<void> {
  try {
    const client = tx || defaultPrisma
    await client.auditLog.create({
      data: {
        actor: input.actor ?? null,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        diffJson: input.diff ? JSON.stringify(input.diff) : null,
      },
    })
  } catch (err: any) {
    logger.warn(
      { module: 'auditLog', action: input.action, targetId: input.targetId, err: err?.message },
      'AuditLog 写入失败（已吞掉不影响主流程）',
    )
  }
}
