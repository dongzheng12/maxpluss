/**
 * 数据导入模块
 * @date   2026-03-21
 */
import { prisma } from './db'

type ClauseInput = {
  key: string
  requirement: string
  weight: number
  indicator?: string
  comparator?: string
  threshold?: number
  unit?: string
  veto?: boolean
}

type StandardInput = {
  code: string
  title: string
  level: string
  source: string
  version: string
  scope: string
}

type PayloadShape = {
  standard?: StandardInput
  clauses?: ClauseInput[]
}

export async function ingestStandard(payload: PayloadShape) {
  if (!payload.standard) {
    throw new Error('Missing standard')
  }
  const standard = await prisma.standard.create({
    data: payload.standard
  })

  if (payload.clauses?.length) {
    await prisma.standardClause.createMany({
      data: payload.clauses.map((clause) => ({
        key: clause.key,
        requirement: clause.requirement,
        weight: clause.weight,
        indicator: clause.indicator ?? clause.key,
        comparator: clause.comparator ?? '>=',
        threshold: clause.threshold ?? 0,
        unit: clause.unit,
        veto: clause.veto ?? false,
        standardId: standard.id
      }))
    })
  }

  return standard
}

export function parseSnippet(snippet: string) {
  const lines = snippet
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const title = lines[0] || '未知标准'
  const codeMatch = snippet.match(/(GB\/?T?\s*\d+[-—]\d+)/i)
  const level = snippet.includes('国家标准') ? '国家' : snippet.includes('行业标准') ? '行业' : '企业'
  return {
    standard: {
      code: codeMatch ? codeMatch[1].replace(/\s+/g, '') : `STD-${Date.now()}`,
      title,
      level,
      source: 'crawler',
      version: 'unknown',
      scope: 'unknown'
    },
    clauses: [] as ClauseInput[]
  }
}
