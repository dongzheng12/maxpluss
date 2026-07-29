/**
 * 销售专属推广主页 — 产品常量
 *
 * MVP 阶段用后端常量（不建产品表）。displayProducts 里只存 code + sort，
 * 前端/落地页渲染时用 code 从这里查详情。新增产品只改此文件 + 前端产品卡片样式。
 */

export type SalesProductActionType = 'REGISTER' | 'CONTACT' | 'INTRO_CONTACT'

export interface SalesProduct {
  code: string                     // 产品唯一 code（与 displayProducts 里的 code 对应）
  name: string                     // 产品名称
  slogan: string                   // 一句话介绍
  description: string              // 详细介绍（落地页/介绍弹窗）
  targetUsers: string              // 适用对象
  features: string[]               // 核心能力（bullet list）
  actionType: SalesProductActionType // 主按钮行为
  ctaLabel: string                 // 主按钮文案
}

export const SALES_PRODUCTS: SalesProduct[] = [
  {
    code: 'xiaozhi',
    name: '标准小智AI',
    slogan: '问标准、做任务、找服务、扫一扫、一站式智能助手',
    description: '问标准、做任务、找服务、扫一扫，一站式标准化智能助手。提供标准信息查询、智能问答、文档比对能力。',
    targetUsers: '企业标准化专员 / 技术部门 / 质量部门',
    features: [
      '标准信息查询',
      '智能问答',
      '文档比对',
    ],
    actionType: 'REGISTER',
    ctaLabel: '立即体验',
  },
  {
    code: 'guan',
    name: '标准管理',
    slogan: '标准资产100%沉淀，全生命闭环',
    description: '标准资产 100% 沉淀，全生命闭环。提供外部标准检索、统一入口、内部标准制修订能力。',
    targetUsers: '有企业标准管理需求的规模化企业',
    features: [
      '外部标准检索',
      '统一入口',
      '内部标准制修订',
    ],
    actionType: 'CONTACT',
    ctaLabel: '查看详情',
  },
  {
    code: 'bian',
    name: '标准编写',
    slogan: '提效40%+，结构化数据产出',
    description: '提效 40%+，结构化数据产出。提供协同起草、格式规范、引用及术语查询能力。',
    targetUsers: '标准起草人员 / 技术编制团队',
    features: [
      '协同起草',
      '格式规范',
      '引用及术语查询',
    ],
    actionType: 'CONTACT',
    ctaLabel: '查看详情',
  },
  {
    code: 'kong',
    name: '标准监测',
    slogan: '全球动态检测 秒级风险预警',
    description: '全球动态检测，秒级风险预警。提供 100+ 组织动态、动态秒推送、权威电子凭证能力。',
    targetUsers: '制造业质量部门 / 标准合规团队',
    features: [
      '100+组织动态',
      '动态秒推送',
      '权威电子凭证',
    ],
    actionType: 'CONTACT',
    ctaLabel: '查看详情',
  },
]

const CODE_SET = new Set(SALES_PRODUCTS.map(p => p.code))

export function isValidProductCode(code: string): boolean {
  return CODE_SET.has(code)
}

export function getProductByCode(code: string): SalesProduct | undefined {
  return SALES_PRODUCTS.find(p => p.code === code)
}

/**
 * 校验 displayProducts JSON 数组格式 + 内容合法性
 * 返回：规范化后的数组（按 sort 升序），或抛错
 */
export function validateDisplayProducts(input: unknown): Array<{ code: string; sort: number }> {
  if (!Array.isArray(input)) throw new Error('displayProducts 必须是数组')
  if (input.length > 4) throw new Error('displayProducts 最多 4 个')
  const seen = new Set<string>()
  const result: Array<{ code: string; sort: number }> = []
  for (const item of input) {
    if (!item || typeof item !== 'object') throw new Error('displayProducts 元素必须是对象')
    const code = (item as any).code
    const sort = (item as any).sort
    if (typeof code !== 'string' || !isValidProductCode(code)) {
      throw new Error(`产品 code 不合法：${code}`)
    }
    if (typeof sort !== 'number' || !Number.isInteger(sort)) {
      throw new Error('sort 必须是整数')
    }
    if (seen.has(code)) throw new Error(`产品 code 重复：${code}`)
    seen.add(code)
    result.push({ code, sort })
  }
  result.sort((a, b) => a.sort - b.sort)
  return result
}
