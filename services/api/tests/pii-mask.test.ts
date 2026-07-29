/**
 * PII 脱敏工具单元测试（2026-04-21）
 *
 * 覆盖：
 *   - maskEmail 正常 / 边界（空、无 @、@开头、@结尾）
 *   - maskPhone 正常 / 边界（空、含空格分隔符、短于 7 位）
 *   - 安全底线：异常输入一律返回 '***'，绝不回显原值
 */
import { describe, it, expect } from 'vitest'
import { maskEmail, maskPhone } from '../src/utils/pii.js'

describe('maskEmail', () => {
  it('正常邮箱', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@example.com')
  })

  it('单字符本地部分', () => {
    expect(maskEmail('a@b.com')).toBe('a***@b.com')
  })

  it('长域名', () => {
    expect(maskEmail('johannes@subdomain.company.co.jp')).toBe('j***@subdomain.company.co.jp')
  })

  it('空字符串 → ***', () => {
    expect(maskEmail('')).toBe('***')
  })

  it('null → ***', () => {
    expect(maskEmail(null)).toBe('***')
  })

  it('undefined → ***', () => {
    expect(maskEmail(undefined)).toBe('***')
  })

  it('无 @ 符号 → ***（不回显原值）', () => {
    expect(maskEmail('not-an-email')).toBe('***')
  })

  it('@ 开头 → ***', () => {
    expect(maskEmail('@example.com')).toBe('***')
  })

  it('@ 结尾 → ***', () => {
    expect(maskEmail('alice@')).toBe('***')
  })

  it('非字符串类型 → ***', () => {
    // @ts-expect-error — 测试运行时容错
    expect(maskEmail(12345)).toBe('***')
  })
})

describe('maskPhone', () => {
  it('11 位中国大陆手机号', () => {
    expect(maskPhone('13812345678')).toBe('138****5678')
  })

  it('带空格分隔符', () => {
    expect(maskPhone('138 1234 5678')).toBe('138****5678')
  })

  it('带 +86 前缀', () => {
    expect(maskPhone('+86 138 1234 5678')).toBe('861****5678')
  })

  it('带连字符', () => {
    expect(maskPhone('138-1234-5678')).toBe('138****5678')
  })

  it('恰好 7 位（边界）', () => {
    expect(maskPhone('1234567')).toBe('123****4567')
  })

  it('短于 7 位 → ***', () => {
    expect(maskPhone('123456')).toBe('***')
  })

  it('空字符串 → ***', () => {
    expect(maskPhone('')).toBe('***')
  })

  it('null → ***', () => {
    expect(maskPhone(null)).toBe('***')
  })

  it('undefined → ***', () => {
    expect(maskPhone(undefined)).toBe('***')
  })

  it('全非数字 → ***', () => {
    expect(maskPhone('abcdefg')).toBe('***')
  })

  it('非字符串类型 → ***', () => {
    // @ts-expect-error — 测试运行时容错
    expect(maskPhone(13812345678)).toBe('***')
  })
})

describe('脱敏安全底线', () => {
  it('maskEmail 永不泄露本地部分中间字符', () => {
    const out = maskEmail('secretuser@example.com')
    expect(out).not.toContain('secretuser')
    expect(out).not.toContain('ecretuser')
    expect(out.startsWith('s')).toBe(true)
  })

  it('maskPhone 永不泄露中间 4 位', () => {
    const out = maskPhone('13812345678')
    expect(out).not.toContain('1234')
    expect(out).toMatch(/\*{4}/)
  })
})
