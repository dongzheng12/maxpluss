import { describe, expect, it } from 'vitest'
import { formatCnyFromCents, formatDate, formatDateTime } from './format'

describe('format helpers', () => {
  it.each([
    [0, '¥0.00'],
    [1, '¥0.01'],
    [123456, '¥1234.56'],
    [-99, '¥-0.99'],
  ])('formats cents %s as CNY', (cents, expected) => {
    expect(formatCnyFromCents(cents)).toBe(expected)
  })

  it('uses fallback for missing or invalid money', () => {
    expect(formatCnyFromCents(null)).toBe('-')
    expect(formatCnyFromCents(undefined)).toBe('-')
    expect(formatCnyFromCents(Number.NaN, 'N/A')).toBe('N/A')
  })

  it('formats date/time with stable patterns', () => {
    expect(formatDateTime('2026-06-05T14:52:39')).toBe('2026-06-05 14:52:39')
    expect(formatDate('2026-06-05T14:52:39')).toBe('2026-06-05')
    expect(formatDateTime('2026-06-05T14:52:39', 'MM-DD HH:mm')).toBe('06-05 14:52')
  })

  it('uses fallback for missing or invalid dates', () => {
    expect(formatDateTime(null)).toBe('-')
    expect(formatDateTime(undefined)).toBe('-')
    expect(formatDateTime('not-a-date', 'YYYY-MM-DD', 'N/A')).toBe('N/A')
  })
})
