/**
 * 合规周期（StandardExecutionPlan）后端接口
 *
 *   POST /api/admin/standard-execution/plans   — Admin 创建（requireAdmin）
 *
 * 校验：
 *   - sourceId 必须存在且属于同一 enterpriseId，否则 400
 *   - status 默认 DRAFT，roundNumber 默认 1，createdBy = userId
 *
 * @see Step 1 架构升级施工单
 */
import type { Express, Response } from 'express'
import { prisma } from '../db.js'
import { requireAdmin, type AuthRequest } from '../auth.js'
import { getEnterpriseId } from './utils.js'
import { PlanCreateSchema } from './types.js'

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

export function registerStandardExecutionPlanRoutes(app: Express) {
  // ─── Admin：创建合规周期 ───────────────────────────────
  app.post(
    '/api/admin/standard-execution/plans',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const parsed = PlanCreateSchema.safeParse(req.body)
      if (!parsed.success) {
        return badRequest(res, parsed.error.issues[0]?.message || '参数错误')
      }
      const enterpriseId = getEnterpriseId(req as never)

      // sourceId FK 校验：source 必须存在且属于同企业
      const source = await prisma.standardExecutionSource.findFirst({
        where: { id: parsed.data.sourceId, enterpriseId },
        select: { id: true },
      })
      if (!source) {
        return badRequest(res, 'sourceId 对应的标准来源不存在或不属于当前企业')
      }

      const data = await prisma.standardExecutionPlan.create({
        data: {
          enterpriseId,
          sourceId: parsed.data.sourceId,
          title: parsed.data.title,
          roundNumber: parsed.data.roundNumber ?? 1,
          scheduledAt: parsed.data.scheduledAt ? new Date(parsed.data.scheduledAt) : null,
          frequency: parsed.data.frequency ?? null,
          startAt: parsed.data.startAt ? new Date(parsed.data.startAt) : null,
          endAt: parsed.data.endAt ? new Date(parsed.data.endAt) : null,
          nextRunAt: parsed.data.nextRunAt ? new Date(parsed.data.nextRunAt) : null,
          defaultReviewerId: parsed.data.defaultReviewerId ?? null,
          defaultAssigneeIds: parsed.data.defaultAssigneeIds ?? [],
          defaultTaskType: parsed.data.defaultTaskType ?? null,
          defaultDeadlineMode: parsed.data.defaultDeadlineMode,
          defaultDeadlineDaysAfterApproval: parsed.data.defaultDeadlineDaysAfterApproval ?? 7,
          status: 'DRAFT',
          createdBy: req.userId!,
        },
      })
      res.status(201).json({ data })
    },
  )
}
