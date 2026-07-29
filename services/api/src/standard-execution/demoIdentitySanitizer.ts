export const SECURITY_ENTERPRISE_NAMES = [
  '华盾安保服务有限公司',
  '城安卫士安全服务有限公司',
  '中安巡防服务有限公司',
  '稳盾安保管理有限公司',
  '恒安护卫服务有限公司',
]

const ROLE_NAME_POOL: Record<string, string[]> = {
  ADMIN: ['周安邦', '林守正', '郑卫国'],
  MANAGER: ['赵建华', '陈立巡', '孙保宁'],
  REVIEWER: ['王守正', '刘明岗', '钱安平'],
  EMPLOYEE: ['李巡安', '吴门岗', '冯护卫', '郭押运', '马值守', '许巡防'],
  DEFAULT: ['何安宁', '高卫民', '曹守业', '杜巡平'],
}

const DEMO_NAME_PATTERNS = [
  /^SMK_/i,
  /^E2E_/i,
  /^POC/i,
  /^poc/i,
  /^se[-_\s]?local/i,
  /测试/,
  /演示/,
  /默认企业/,
  /默认员工/,
  /本地/,
]

export function isDemoLikeName(value: string | null | undefined): boolean {
  const text = String(value || '').trim()
  if (!text) return true
  return DEMO_NAME_PATTERNS.some((pattern) => pattern.test(text))
}

export function securityEnterpriseName(index: number): string {
  return SECURITY_ENTERPRISE_NAMES[index % SECURITY_ENTERPRISE_NAMES.length]
}

export function securityUserName(role: string | null | undefined, index: number): string {
  const pool = ROLE_NAME_POOL[String(role || '').toUpperCase()] || ROLE_NAME_POOL.DEFAULT
  return pool[index % pool.length]
}

export function shouldRenameEnterprise(input: { id: string; code: string; name: string }, targetIds: Set<string>): boolean {
  if (targetIds.has(input.id)) return true
  return isDemoLikeName(input.id) || isDemoLikeName(input.code) || isDemoLikeName(input.name)
}

export function shouldRenameUser(
  input: { id: string; name: string | null; enterpriseId: string | null; enterpriseRole: string | null },
  targetEnterpriseIds: Set<string>,
): boolean {
  if (!input.enterpriseId || !input.enterpriseRole) return false
  if (targetEnterpriseIds.has(input.enterpriseId)) return true
  return isDemoLikeName(input.id) || isDemoLikeName(input.name)
}
