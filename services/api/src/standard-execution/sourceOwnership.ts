import { z } from 'zod'

export const SOURCE_OWNERSHIP_TIERS = ['R', 'O'] as const
export type SourceOwnershipTier = (typeof SOURCE_OWNERSHIP_TIERS)[number]

export const OWNED_SOURCE_DECLARATION_DRAFT =
  '我确认本文档为本企业自有或已取得合法授权使用；本文档不含任何受版权保护的公开标准全文或大段原文；因违反上述声明产生的版权及合规责任由声明方承担。'

export const SourceOwnershipUpdateSchema = z.object({
  ownershipTier: z.enum(SOURCE_OWNERSHIP_TIERS),
  declarationAccepted: z.boolean().optional(),
  declarationText: z.string().trim().min(20).max(2000).optional(),
})

export function normalizeOwnershipTier(value: string | null | undefined): SourceOwnershipTier {
  return value === 'O' ? 'O' : 'R'
}

export function canManageSourceOwnership(role: string | null | undefined): boolean {
  return role === 'ADMIN' || role === 'MANAGER'
}
