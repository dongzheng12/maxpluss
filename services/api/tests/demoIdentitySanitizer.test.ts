import { describe, expect, it } from 'vitest'
import {
  isDemoLikeName,
  securityEnterpriseName,
  securityUserName,
  shouldRenameEnterprise,
  shouldRenameUser,
} from '../src/standard-execution/demoIdentitySanitizer.js'

describe('demo identity sanitizer', () => {
  it('识别 T13/烟测/演示残留命名', () => {
    expect(isDemoLikeName('SMK_SE_123_员工')).toBe(true)
    expect(isDemoLikeName('E2E_企业')).toBe(true)
    expect(isDemoLikeName('POC 安保演示')).toBe(true)
    expect(isDemoLikeName('华盾安保服务有限公司')).toBe(false)
  })

  it('企业命中目标 ID 或演示前缀才改名', () => {
    expect(shouldRenameEnterprise(
      { id: 'ENT_REAL', code: 'REAL', name: '真实客户' },
      new Set(['ENT_REAL']),
    )).toBe(true)
    expect(shouldRenameEnterprise(
      { id: 'SMK_001', code: 'SMK_001', name: '烟测企业' },
      new Set(),
    )).toBe(true)
    expect(shouldRenameEnterprise(
      { id: 'ENT_REAL', code: 'REAL', name: '真实客户' },
      new Set(),
    )).toBe(false)
  })

  it('只治理企业成员展示名，不碰个人用户语义', () => {
    expect(shouldRenameUser(
      { id: 'u1', name: '演示员工', enterpriseId: 'DEFAULT', enterpriseRole: 'EMPLOYEE' },
      new Set(),
    )).toBe(true)
    expect(shouldRenameUser(
      { id: 'u2', name: '真实用户', enterpriseId: null, enterpriseRole: null },
      new Set(['DEFAULT']),
    )).toBe(false)
    expect(shouldRenameUser(
      { id: 'u3', name: '真实员工', enterpriseId: 'DEFAULT', enterpriseRole: 'REVIEWER' },
      new Set(['DEFAULT']),
    )).toBe(true)
  })

  it('输出安保行业展示名', () => {
    expect(securityEnterpriseName(0)).toContain('安保')
    expect(securityUserName('EMPLOYEE', 0)).toBe('李巡安')
    expect(securityUserName('REVIEWER', 0)).toBe('王守正')
  })
})
