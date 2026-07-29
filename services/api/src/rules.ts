/**
 * 规则引擎
 * @date   2026-03-21
 */
import { prisma } from './db'

export type RuleInput = {
  barcode?: string
  imageBase64?: string
}

export type RuleDetail = {
  key: string
  indicator: string
  requirement: string
  comparator: string
  threshold: number
  unit?: string | null
  actualValue?: number | null
  weight: number
  passed: boolean | null
  veto: boolean
  scoreContribution: number
  message: string
}

export type RuleResult = {
  score: number
  compliance: string
  suggestion: string
  details: RuleDetail[]
  productName?: string
  standards?: { code: string; title: string; level: string }[]
}

type ExpressionNode =
  | number
  | { var: string }
  | { op: 'add' | 'sub' | 'mul' | 'div' | 'min' | 'max' | 'avg'; args: ExpressionNode[] }

function clampScore(value: number) {
  return Math.min(98, Math.max(40, Math.round(value)))
}

function compareValue(actual: number, threshold: number, comparator: string): boolean {
  switch (comparator) {
    case '>':
      return actual > threshold
    case '>=':
      return actual >= threshold
    case '<':
      return actual < threshold
    case '<=':
      return actual <= threshold
    case '=':
    case '==':
      return actual === threshold
    case '!=':
      return actual !== threshold
    default:
      return false
  }
}

function evaluateExpression(node: ExpressionNode, context: Record<string, number>): number {
  if (typeof node === 'number') return node
  if ('var' in node) return context[node.var] ?? 0
  const values = node.args.map((arg) => evaluateExpression(arg, context))
  switch (node.op) {
    case 'add':
      return values.reduce((sum, value) => sum + value, 0)
    case 'sub':
      return values.slice(1).reduce((sum, value) => sum - value, values[0] ?? 0)
    case 'mul':
      return values.reduce((sum, value) => sum * value, 1)
    case 'div':
      return values.slice(1).reduce((sum, value) => sum / (value || 1), values[0] ?? 0)
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
    case 'avg':
      return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
    default:
      return 0
  }
}

export async function assessByRules(input: RuleInput): Promise<RuleResult> {
  if (input.barcode) {
    const mapping = await prisma.productMapping.findFirst({
      where: { value: input.barcode },
      include: { product: true }
    })

    const standardIds = mapping?.standardIds ? (JSON.parse(mapping.standardIds) as string[]) : []
    const standards = standardIds.length
      ? await prisma.standard.findMany({
          where: { code: { in: standardIds } }
        })
      : []

    const clauses = standards.length
      ? await prisma.standardClause.findMany({
          where: { standardId: { in: standards.map((s) => s.id) } }
        })
      : []

    const productionStandards = mapping?.productId
      ? await prisma.productionStandard.findMany({
          where: {
            productId: mapping.productId,
            standardId: { in: standards.map((s) => s.id) }
          },
          orderBy: { createdAt: 'desc' },
          include: { reportItems: true }
        })
      : []

    const productionByStandard = new Map<string, (typeof productionStandards)[number]>()
    for (const item of productionStandards) {
      if (!productionByStandard.has(item.standardId)) {
        productionByStandard.set(item.standardId, item)
      }
    }

    const reportIndex = new Map<string, Map<string, (typeof productionStandards)[number]['reportItems'][number]>>()
    for (const [standardId, entry] of productionByStandard) {
      const indicatorMap = new Map<string, (typeof entry.reportItems)[number]>()
      for (const report of entry.reportItems) {
        if (!indicatorMap.has(report.indicator)) {
          indicatorMap.set(report.indicator, report)
        }
      }
      reportIndex.set(standardId, indicatorMap)
    }

    const details: RuleDetail[] = clauses.map((clause) => {
      const item = reportIndex.get(clause.standardId)?.get(clause.indicator)
      if (!item) {
        return {
          key: clause.key,
          indicator: clause.indicator,
          requirement: clause.requirement,
          comparator: clause.comparator,
          threshold: clause.threshold,
          unit: clause.unit,
          actualValue: null,
          weight: clause.weight,
          passed: null,
          veto: clause.veto,
          scoreContribution: 0,
          message: '缺少检测数据'
        }
      }
      const passed = compareValue(item.value, clause.threshold, clause.comparator)
      return {
        key: clause.key,
        indicator: clause.indicator,
        requirement: clause.requirement,
        comparator: clause.comparator,
        threshold: clause.threshold,
        unit: clause.unit,
        actualValue: item.value,
        weight: clause.weight,
        passed,
        veto: clause.veto,
        scoreContribution: passed ? clause.weight : 0,
        message: passed ? '符合标准' : '不符合标准'
      }
    })

    const totalWeight = details.reduce((sum, item) => sum + item.weight, 0)
    const weightedPass = details.reduce((sum, item) => sum + item.scoreContribution, 0)
    const baseScore = totalWeight > 0 ? Math.round((weightedPass / totalWeight) * 100) : 70
    const vetoFailed = details.some((item) => item.veto && item.passed === false)
    const finalScore = clampScore(vetoFailed ? Math.min(baseScore, 40) : baseScore)

    const compliance = vetoFailed ? '不合规' : finalScore >= 80 ? '合规' : '部分合规'
    const suggestion = vetoFailed ? '不推荐' : finalScore >= 85 ? '推荐购买' : '谨慎购买'

    return {
      score: finalScore,
      compliance,
      suggestion,
      details,
      productName: mapping?.product?.name,
      standards: standards.map((item) => ({
        code: item.code,
        title: item.title,
        level: item.level
      }))
    }
  }

  if (input.imageBase64) {
    return {
      score: 86,
      compliance: '合规',
      suggestion: '推荐购买',
      details: []
    }
  }

  return {
    score: 0,
    compliance: '未知',
    suggestion: '请先识别商品',
    details: []
  }
}
