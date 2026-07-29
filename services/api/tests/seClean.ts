import { prisma } from '../src/db.js'

export const CLEAN_STANDARD_EXECUTION_MODEL_DELEGATES = [
  'enterpriseApiAccessLog',
  'enterpriseWebhookDelivery',
  'enterpriseWebhook',
  'enterpriseApiKey',
  'sEParseJob',
  'sEVectorIndexItem',
  'sERecordCoverage',
  'sERequirementMapping',
  'standardExecutionPackageItem',
  'standardExecutionPackage',
  'standardExecutionRisk',
  'standardExecutionReviewLog',
  'standardExecutionAttachment',
  'standardExecutionRecord',
  'standardExecutionSubmission',
  'standardExecutionTaskAssignee',
  'sEQuizResult',
  'standardExecutionTaskItemProgress',
  'standardExecutionTaskItem',
  'standardExecutionTaskApprovalLog',
  'standardExecutionTask',
  'standardExecutionPlanRun',
  'standardExecutionPlan',
  'sEComplianceCycle',
  'sEComplianceCycleTemplate',
  'standardExecutionRequirement',
  'standardExecutionSourceDeclaration',
  'standardExecutionSource',
  'sEIndustryTemplateItem',
  'sEIndustryTemplate',
  'sEQuestionBank',
] as const

/**
 * 清理 standard-execution 全模块测试数据。
 *
 * 按 FK 依赖拓扑序删除；新增 SE 表时只改这里，避免每个测试文件手抄删表序。
 */
export async function cleanStandardExecutionData() {
  for (const delegateName of CLEAN_STANDARD_EXECUTION_MODEL_DELEGATES) {
    await prisma[delegateName].deleteMany()
  }
}
