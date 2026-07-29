/**
 * 测试数据唯一前缀生成
 *
 * - SMOKE_<ENV>_<runStartTimestamp>_  作为 baseline（一次 smoke 运行内一致）
 * - 派生命名：rolePrefix(name) = baseline + 'ROLE_' + name
 * - cleanup 按 baseline 前缀做 startsWith 匹配
 */
import type { SmokeEnv } from '../types'

export function rolePrefixed(env: SmokeEnv, name: string): string {
  return `${env.cleanupPrefix}ROLE_${name}`
}

export function isOurPrefix(env: SmokeEnv, value: string | null | undefined): boolean {
  if (!value) return false
  return value.startsWith(env.cleanupPrefix)
}
