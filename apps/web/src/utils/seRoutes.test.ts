import { describe, expect, it } from 'vitest'
import { isSERoute } from './seRoutes'

describe('isSERoute', () => {
  it.each([
    '/admin/standard-execution',
    '/admin/standard-execution/tasks',
    '/admin/standard-execution/task-generation',
    '/enterprise',
    '/enterprise/my-tasks',
  ])('allows SE route %s', (pathname) => {
    expect(isSERoute(pathname)).toBe(true)
  })

  it.each([
    '/',
    '/admin',
    '/admin/orders',
    '/admin/expert-votes',
    '/admin/standard-execution2',
    '/enterprise-old',
  ])('rejects non-SE route %s', (pathname) => {
    expect(isSERoute(pathname)).toBe(false)
  })
})
