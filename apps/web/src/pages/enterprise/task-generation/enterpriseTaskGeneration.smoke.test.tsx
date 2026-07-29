// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// TaskGenerationWorkbench is exercised elsewhere; this verifies the enterprise
// page wires it with scope="enterprise".
vi.mock('../../../components/se/TaskGenerationWorkbench', () => ({
  default: (props: { scope?: string }) => <div data-testid="task-gen" data-scope={props.scope} />,
}))

import { renderWithProviders, screen } from '../../../test/utils'
import EnterpriseTaskGenerationPage from './index'

describe('EnterpriseTaskGenerationPage smoke', () => {
  it('mounts the task-generation workbench in enterprise scope', () => {
    renderWithProviders(<EnterpriseTaskGenerationPage />, { route: '/enterprise/task-generation' })
    const tg = screen.getByTestId('task-gen')
    expect(tg).toBeInTheDocument()
    expect(tg).toHaveAttribute('data-scope', 'enterprise')
  })
})
