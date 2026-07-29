import { describe, expect, it } from 'vitest'
import {
  fallbackBenefitsMatrix,
  isMembershipBenefitsMatrix,
  resolveBenefitsMatrix,
} from './benefitsMatrix'

// Pure-function coverage for the benefits matrix resolver: remote config is only
// honored when structurally valid, otherwise the shipped fallback wins.
describe('resolveBenefitsMatrix', () => {
  it('keeps the four comparison columns in the fallback matrix', () => {
    expect(fallbackBenefitsMatrix.columns.map((c) => c.key)).toEqual(['guest', 'free', 'personal', 'pro'])
  })

  it('falls back when the remote value is missing or malformed', () => {
    expect(resolveBenefitsMatrix(undefined)).toBe(fallbackBenefitsMatrix)
    expect(resolveBenefitsMatrix(null)).toBe(fallbackBenefitsMatrix)
    expect(resolveBenefitsMatrix({ columns: [] })).toBe(fallbackBenefitsMatrix)
    expect(resolveBenefitsMatrix('nope')).toBe(fallbackBenefitsMatrix)
  })

  it('honors a structurally valid remote matrix', () => {
    expect(isMembershipBenefitsMatrix(fallbackBenefitsMatrix)).toBe(true)
    expect(resolveBenefitsMatrix(fallbackBenefitsMatrix)).toBe(fallbackBenefitsMatrix)
  })
})
