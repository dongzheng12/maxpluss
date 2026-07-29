/**
 * phoneResolver 单元测试 — 解析层 / 去重 / 上限 / DB 匹配
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { prisma } from '../src/db.js'
import {
  phonesToUsers,
  parsePhoneInput,
  PhoneBatchLimitError,
  PHONE_BATCH_LIMIT,
} from '../src/services/phoneResolver.js'
import { createUser } from './factory.js'

beforeAll(async () => {
  // 清掉可能干扰的旧 user（按 phone 范围）
})

beforeEach(async () => {
  await prisma.appUser.deleteMany({
    where: { phone: { startsWith: '13900' } },
  })
})

describe('parsePhoneInput — 输入解析', () => {
  it('多行/逗号/空格/分号混合分隔', () => {
    const raw = '13900000001,13900000002\n13900000003 13900000004;13900000005\t13900000006'
    expect(parsePhoneInput(raw)).toEqual([
      '13900000001', '13900000002', '13900000003',
      '13900000004', '13900000005', '13900000006',
    ])
  })

  it('空字符串 / 仅分隔符 → 空数组', () => {
    expect(parsePhoneInput('')).toEqual([])
    expect(parsePhoneInput('  ,;\n\t  ')).toEqual([])
  })

  it('保持首次出现顺序（不排序）', () => {
    expect(parsePhoneInput('13900000003,13900000001,13900000002')).toEqual([
      '13900000003', '13900000001', '13900000002',
    ])
  })
})

describe('phonesToUsers — 匹配 + 去重 + 上限', () => {
  it('已注册手机号 → found，未注册 → notFound', async () => {
    const u1 = await createUser({ phone: '13900000001', password: 'x' })
    const u2 = await createUser({ phone: '13900000002', password: 'x' })

    const r = await phonesToUsers(['13900000001', '13900000002', '13900000099'])
    expect(r.found).toHaveLength(2)
    const foundIds = r.found.map(f => f.id).sort()
    expect(foundIds).toEqual([u1.id, u2.id].sort())
    expect(r.notFound).toEqual(['13900000099'])
    expect(r.invalid).toEqual([])
  })

  it('重复手机号自动去重', async () => {
    await createUser({ phone: '13900000001', password: 'x' })
    const r = await phonesToUsers('13900000001,13900000001\n13900000001')
    expect(r.found).toHaveLength(1)
    expect(r.totalParsed).toBe(1)
  })

  it('非法格式 → invalid（不进 notFound）', async () => {
    const r = await phonesToUsers(['12345', 'abc', '13900000099'])
    expect(r.invalid.sort()).toEqual(['12345', 'abc'])
    expect(r.notFound).toEqual(['13900000099'])
    expect(r.found).toEqual([])
  })

  it('超 100 个抛 PhoneBatchLimitError', async () => {
    const phones = Array.from({ length: 101 }, (_, i) =>
      `139${String(i).padStart(8, '0')}`
    )
    await expect(phonesToUsers(phones)).rejects.toBeInstanceOf(PhoneBatchLimitError)
  })

  it('恰好 100 个不抛', async () => {
    const phones = Array.from({ length: PHONE_BATCH_LIMIT }, (_, i) =>
      `139${String(i).padStart(8, '0')}`
    )
    const r = await phonesToUsers(phones)
    expect(r.totalParsed).toBe(PHONE_BATCH_LIMIT)
    // 这些都未注册
    expect(r.notFound).toHaveLength(PHONE_BATCH_LIMIT)
  })

  it('支持单字符串输入 → 内部 parse', async () => {
    await createUser({ phone: '13900000001', password: 'x' })
    const r = await phonesToUsers('13900000001\n13900000099')
    expect(r.found).toHaveLength(1)
    expect(r.notFound).toEqual(['13900000099'])
  })

  it('空输入 → 空结果', async () => {
    const r = await phonesToUsers('')
    expect(r.found).toEqual([])
    expect(r.notFound).toEqual([])
    expect(r.invalid).toEqual([])
    expect(r.totalParsed).toBe(0)
  })
})
