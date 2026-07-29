/* eslint-disable react-refresh/only-export-components */
import type { ReactElement, ReactNode } from 'react'
import { render, type RenderOptions, type RenderResult } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AuthProvider } from '../contexts/AuthContext'

export interface ProvidersOptions {
  /** Initial router history entries; defaults to ['/']. */
  route?: string | string[]
  /** Wrap in AuthProvider (reads localStorage on mount); defaults to true. */
  withAuth?: boolean
}

function Providers({
  children,
  route = '/',
  withAuth = true,
}: ProvidersOptions & { children: ReactNode }) {
  const entries = Array.isArray(route) ? route : [route]
  const tree = <MemoryRouter initialEntries={entries}>{children}</MemoryRouter>
  return withAuth ? <AuthProvider>{tree}</AuthProvider> : tree
}

/**
 * Render a page/component inside the providers every page assumes: a router and
 * (optionally) the auth context. Mock API modules with `vi.mock` in the test
 * file before calling this so no real network happens.
 */
export function renderWithProviders(
  ui: ReactElement,
  { route, withAuth, ...options }: ProvidersOptions & Omit<RenderOptions, 'wrapper'> = {},
): RenderResult {
  return render(ui, {
    wrapper: ({ children }) => (
      <Providers route={route} withAuth={withAuth}>
        {children}
      </Providers>
    ),
    ...options,
  })
}

export * from '@testing-library/react'
export { default as userEvent } from '@testing-library/user-event'
