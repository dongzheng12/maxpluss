import type { Express, Response } from 'express'
import { prisma } from '../db.js'
import { requireAdmin, type AuthRequest } from '../auth.js'
import { getEnterpriseId } from './utils.js'
import { runVectorIndexOnce } from '../vectorIndexWorker.js'

function badRequest(res: Response, msg: string) {
  return res.status(400).json({ error: msg })
}

export function registerStandardExecutionVectorRoutes(app: Express) {
  app.post(
    '/api/admin/standard-execution/vector-index/run-once',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const enterpriseId = getEnterpriseId(req as never)
      const limitRaw = req.body?.limit
      const limit = limitRaw === undefined ? undefined : Number(limitRaw)
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0 || limit > 1000)) {
        return badRequest(res, 'limit 必须是 1-1000 的数字')
      }
      const stats = await runVectorIndexOnce({ enterpriseId, limit })
      res.json({ data: stats })
    },
  )

  app.get(
    '/api/admin/standard-execution/vector-index/status',
    requireAdmin as never,
    async (req: AuthRequest, res) => {
      const enterpriseId = getEnterpriseId(req as never)
      const grouped = await prisma.sEVectorIndexItem.groupBy({
        by: ['collection', 'status'],
        where: { enterpriseId },
        _count: { _all: true },
      })
      res.json({
        data: grouped.map((row) => ({
          collection: row.collection,
          status: row.status,
          count: row._count._all,
        })),
      })
    },
  )
}
