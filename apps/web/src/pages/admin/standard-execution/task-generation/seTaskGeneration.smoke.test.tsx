// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// TaskGenerationWorkbench is covered separately; verify this page wires it with scope="admin".
vi.mock('../../../../components/se/TaskGenerationWorkbench', () => ({
  default: (props: { scope?: string }) => <div data-testid="task-gen" data-scope={props.scope} />,
}))

import { renderWithProviders, screen } from '../../../../test/utils'
import SeTaskGenerationPage from './index'

describe('SeTaskGenerationPage (admin) smoke', () => {
  it('mounts the task-generation workbench in admin scope', () => {
    renderWithProviders(<SeTaskGenerationPage />, { route: '/admin/standard-execution/task-generation' })
    const tg = screen.getByTestId('task-gen')
    expect(tg).toBeInTheDocument()
    expect(tg).toHaveAttribute('data-scope', 'admin')
  })
})
