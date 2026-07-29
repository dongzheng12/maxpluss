/**
 * runPaymentTx retry wrapper 单测
 *
 * 覆盖：
 *  - PAYMENT_RETRY_CODES 集合内容
 *  - 正常成功路径
 *  - P2034 / 25P02 / 40001 retry 上限内成功
 *  - 重试上限后抛原错误
 *  - 非 retryable 错误立即抛、不重试
 *
 * 注：fn 在真实 prisma.$transaction 内运行 — 抛错时 prisma 会 ROLLBACK 真实事务，
 *      错误 code 透传不变。
 */
import { describe, it, expect } from 'vitest'
import { runPaymentTx, PAYMENT_RETRY_CODES, isRetryablePaymentError } from '../src/appRoutes.js'

function makePrismaErr(code: string, message = 'simulated'): Error {
  const err: any = new Error(message)
  err.code = code
  return err
}

// 模拟 PrismaClientUnknownRequestError —— 没 err.code，code 在 message 字符串里
function makePrismaUnknownErr(sqlstate: string): Error {
  const err: any = new Error(
    `Invalid \`tx.referral.findUnique()\` invocation\n` +
    `Error occurred during query execution:\n` +
    `ConnectorError(ConnectorError { kind: QueryError(PostgresError { code: "${sqlstate}", message: "current transaction is aborted, commands ignored until end of transaction block", severity: "ERROR" }), transient: false })`,
  )
  err.name = 'PrismaClientUnknownRequestError'
  // 注意：没有 err.code 属性
  return err
}

describe('PAYMENT_RETRY_CODES', () => {
  it('包含 P2034 / 25P02 / 40001', () => {
    expect(PAYMENT_RETRY_CODES.has('P2034')).toBe(true)
    expect(PAYMENT_RETRY_CODES.has('25P02')).toBe(true)
    expect(PAYMENT_RETRY_CODES.has('40001')).toBe(true)
  })

  it('不包含 P1008 / P2028 / P2002（保持当前外层兜底语义）', () => {
    expect(PAYMENT_RETRY_CODES.has('P1008')).toBe(false)
    expect(PAYMENT_RETRY_CODES.has('P2028')).toBe(false)
    expect(PAYMENT_RETRY_CODES.has('P2002')).toBe(false)
  })
})

describe('isRetryablePaymentError', () => {
  it('PrismaClientKnownRequestError 走 err.code 分支', () => {
    expect(isRetryablePaymentError(makePrismaErr('P2034'))).toBe(true)
    expect(isRetryablePaymentError(makePrismaErr('25P02'))).toBe(true)
    expect(isRetryablePaymentError(makePrismaErr('40001'))).toBe(true)
    expect(isRetryablePaymentError(makePrismaErr('P2002'))).toBe(false)
    expect(isRetryablePaymentError(makePrismaErr('P1008'))).toBe(false)
  })

  it('PrismaClientUnknownRequestError 走 message 字符串分支（无 err.code）', () => {
    expect(isRetryablePaymentError(makePrismaUnknownErr('25P02'))).toBe(true)
    expect(isRetryablePaymentError(makePrismaUnknownErr('40001'))).toBe(true)
    expect(isRetryablePaymentError(makePrismaUnknownErr('P2034'))).toBe(true)
  })

  it('普通 Error / 无 message → false', () => {
    expect(isRetryablePaymentError(new Error('plain'))).toBe(false)
    expect(isRetryablePaymentError({})).toBe(false)
    expect(isRetryablePaymentError(null)).toBe(false)
    expect(isRetryablePaymentError(undefined)).toBe(false)
  })

  it('SQLSTATE 仅在 message 里为子串但非完整 PG code 格式 → false', () => {
    // 防止把无关字符串当成 retryable
    const err = new Error('user 25P02 phone number')
    expect(isRetryablePaymentError(err)).toBe(false)
  })
})

describe('runPaymentTx — 正常成功路径', () => {
  it('fn 一次成功 → 直接返回', async () => {
    let attempts = 0
    const r = await runPaymentTx(async () => {
      attempts++
      return 42
    })
    expect(r).toBe(42)
    expect(attempts).toBe(1)
  })
})

describe('runPaymentTx — retry 行为', () => {
  it('P2034 重试 2 次后成功（attempts=3）', async () => {
    let attempts = 0
    const r = await runPaymentTx(async () => {
      attempts++
      if (attempts <= 2) throw makePrismaErr('P2034', 'SSI conflict')
      return 'ok'
    })
    expect(r).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('25P02 也按 retry 处理', async () => {
    let attempts = 0
    const r = await runPaymentTx(async () => {
      attempts++
      if (attempts < 2) throw makePrismaErr('25P02', 'aborted')
      return 'ok25'
    })
    expect(r).toBe('ok25')
    expect(attempts).toBe(2)
  })

  it('40001 也按 retry 处理', async () => {
    let attempts = 0
    const r = await runPaymentTx(async () => {
      attempts++
      if (attempts < 2) throw makePrismaErr('40001', 'serialization_failure')
      return 'ok40001'
    })
    expect(r).toBe('ok40001')
    expect(attempts).toBe(2)
  })

  it('PrismaClientUnknownRequestError(25P02) — 通过 message 识别并 retry', async () => {
    let attempts = 0
    const r = await runPaymentTx(async () => {
      attempts++
      if (attempts < 2) throw makePrismaUnknownErr('25P02')
      return 'recovered'
    })
    expect(r).toBe('recovered')
    expect(attempts).toBe(2)
  })

  it('P2034 持续抛 → 重试 maxRetries=3 次后抛原错误（attempts=4）', async () => {
    let attempts = 0
    await expect(
      runPaymentTx(async () => {
        attempts++
        throw makePrismaErr('P2034', 'persistent SSI')
      }, 3),
    ).rejects.toMatchObject({ code: 'P2034' })
    expect(attempts).toBe(4) // 1 初次 + 3 retry
  })

  it('maxRetries=0 → 不 retry，直接抛', async () => {
    let attempts = 0
    await expect(
      runPaymentTx(async () => {
        attempts++
        throw makePrismaErr('P2034')
      }, 0),
    ).rejects.toMatchObject({ code: 'P2034' })
    expect(attempts).toBe(1)
  })
})

describe('runPaymentTx — 非 retryable 错误立即抛', () => {
  it('P2002 unique constraint → 立即抛、不 retry', async () => {
    let attempts = 0
    await expect(
      runPaymentTx(async () => {
        attempts++
        throw makePrismaErr('P2002', 'unique_violation')
      }),
    ).rejects.toMatchObject({ code: 'P2002' })
    expect(attempts).toBe(1)
  })

  it('P1008 timeout（外层兜底，不在本 wrapper 重试）→ 立即抛', async () => {
    let attempts = 0
    await expect(
      runPaymentTx(async () => {
        attempts++
        throw makePrismaErr('P1008', 'timeout')
      }),
    ).rejects.toMatchObject({ code: 'P1008' })
    expect(attempts).toBe(1)
  })

  it('普通 Error（无 code）→ 立即抛', async () => {
    let attempts = 0
    const plainErr = new Error('plain error')
    await expect(
      runPaymentTx(async () => {
        attempts++
        throw plainErr
      }),
    ).rejects.toThrow('plain error')
    expect(attempts).toBe(1)
  })
})
