import type { PackageScene } from './enums.js'
import type { PackageGenerationOptionsInput } from './types.js'

export const PACKAGE_TEMPLATE_KEYS = ['CUSTOMER_AUDIT', 'CERTIFICATION_PREP', 'ANNUAL_ARCHIVE', 'CUSTOM'] as const
export type PackageTemplateKey = (typeof PACKAGE_TEMPLATE_KEYS)[number]

export interface PackageTemplate {
  key: PackageTemplateKey
  title: string
  packageScene: PackageScene
  description: string
  defaultOptions: Required<PackageGenerationOptionsInput>
  rangePreset: 'SOURCE_OR_DATE' | 'CERTIFICATION_SCOPE' | 'YEAR_TO_DATE' | 'MANUAL'
}

const fullTraceOptions: Required<PackageGenerationOptionsInput> = {
  includeManifest: true,
  includeAuditTrace: true,
  includeBasisClauses: true,
  includeStatisticsSummary: true,
}

export const PACKAGE_TEMPLATES: PackageTemplate[] = [
  {
    key: 'CUSTOMER_AUDIT',
    title: '客户审核包',
    packageScene: 'CUSTOMER_AUDIT',
    description: '面向客户审核的主报告、审计追溯表、证据附件与 README 汇总。',
    defaultOptions: fullTraceOptions,
    rangePreset: 'SOURCE_OR_DATE',
  },
  {
    key: 'CERTIFICATION_PREP',
    title: '认证准备包',
    packageScene: 'CERTIFICATION',
    description: '面向认证准备的标准依据、执行记录、审核链路与证据附件汇总。',
    defaultOptions: fullTraceOptions,
    rangePreset: 'CERTIFICATION_SCOPE',
  },
  {
    key: 'ANNUAL_ARCHIVE',
    title: '年度归档包',
    packageScene: 'TRAINING_ARCHIVE',
    description: '面向年度留档的执行记录、统计摘要、追溯表与附件目录汇总。',
    defaultOptions: {
      ...fullTraceOptions,
      includeBasisClauses: false,
    },
    rangePreset: 'YEAR_TO_DATE',
  },
  {
    key: 'CUSTOM',
    title: '自定义审计包',
    packageScene: 'OTHER',
    description: '按手动选择范围生成审计包。',
    defaultOptions: {
      includeManifest: false,
      includeAuditTrace: true,
      includeBasisClauses: false,
      includeStatisticsSummary: false,
    },
    rangePreset: 'MANUAL',
  },
]

export function findPackageTemplate(key: string | null | undefined) {
  return PACKAGE_TEMPLATES.find((template) => template.key === key)
}
