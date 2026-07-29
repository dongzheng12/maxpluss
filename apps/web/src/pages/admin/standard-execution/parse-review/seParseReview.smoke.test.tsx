// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Route, Routes } from 'react-router-dom'

const seGetParseV2Job = vi.fn()
const seGetSource = vi.fn()
const seCreateRequirement = vi.fn()
const seRegenerateParseV2Requirement = vi.fn()

vi.mock('../../../../api/standardExecution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../api/standardExecution')>()),
  seGetParseV2Job: () => seGetParseV2Job(),
  seGetSource: () => seGetSource(),
  seCreateRequirement: (body: Record<string, unknown>) => seCreateRequirement(body),
  seRegenerateParseV2Requirement: (jobId: string, index: number) => seRegenerateParseV2Requirement(jobId, index),
}))

import { renderWithProviders, screen, waitFor, userEvent } from '../../../../test/utils'
import SeParseReviewPage from './index'

const result = {
  version: 'v2',
  sourceId: 'src-1',
  requirements: [
    {
      clauseNo: '4.1',
      title: '门岗来访登记',
      requirementText: '门岗值守人员应核验来访人员身份并登记进出时间。',
      executionDescription: '核验来访人员身份，登记姓名、单位、事由和进出时间。',
      recommendedTaskType: 'INSPECTION_FILL',
      suggestedDepartment: '安保部',
      suggestedFrequency: '每次来访',
      submitRequirement: '上传来访登记台账',
      requiredMaterials: ['来访登记台账'],
      confidence: 0.88,
      reasoning: '原文动作明确。',
      sourceChunks: ['chunk:0', 'requirement_points:req-1'],
      needsReview: false,
    },
    {
      clauseNo: '4.2',
      title: '巡逻记录留存',
      requirementText: '巡逻人员应每日按路线巡查并保存巡更记录。',
      executionDescription: '每日核查巡逻路线完成情况，并上传巡更记录。',
      recommendedTaskType: 'INSPECTION_FILL',
      suggestedDepartment: '安保部',
      suggestedFrequency: '每日',
      submitRequirement: '上传巡更记录',
      requiredMaterials: ['巡更记录'],
      confidence: 0.42,
      reasoning: '需要人工确认保存期限。',
      sourceChunks: ['chunk:1'],
      needsReview: true,
    },
  ],
  chunks: [
    {
      chunk: { clauseNo: '4.1', title: '门岗值守', text: '4.1 门岗值守\n门岗值守人员应核验来访人员身份并登记进出时间。', chunkIndex: 0 },
      similarClauses: [],
      similarRequirements: [],
      similarRecords: [],
      searchSnippets: [],
    },
    {
      chunk: { clauseNo: '4.2', title: '巡逻检查', text: '4.2 巡逻检查\n巡逻人员应每日按路线巡查并保存巡更记录。', chunkIndex: 1 },
      similarClauses: [],
      similarRequirements: [],
      similarRecords: [],
      searchSnippets: [],
    },
  ],
  metadata: {
    version: 'E2_PARSE_V2',
    sourceId: 'src-1',
    sourceTitle: '安保服务规范',
    sourceNo: 'T/SEC 1',
    chunkCount: 2,
    requirementCount: 2,
    degradedSteps: [],
    retrieval: { standardClauses: 0, requirementPoints: 0, executionRecords: 0, internetSnippets: 0 },
    generatedAt: '2026-06-18T00:00:00.000Z',
    disclaimer: '仅供参考，最终以人工审核为准',
  },
}

describe('SeParseReviewPage', () => {
  beforeEach(() => {
    seGetParseV2Job.mockReset().mockResolvedValue({
      jobId: 'job-1',
      sourceId: 'src-1',
      status: 'DONE',
      progress: 100,
      step: 'DONE',
      result,
      errorMessage: null,
      createdAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:00.000Z',
      startedAt: null,
      finishedAt: '2026-06-18T00:00:01.000Z',
    })
    seGetSource.mockReset()
    seCreateRequirement.mockReset().mockResolvedValue({ data: { id: 'req-new' } })
    seRegenerateParseV2Requirement.mockReset()
    window.HTMLElement.prototype.scrollIntoView = vi.fn()
  })

  it('renders job result and commits selected drafts as DRAFT requirements', async () => {
    const user = userEvent.setup()
    renderWithProviders(
      <Routes>
        <Route path="/admin/standard-execution/sources/:sourceId/parse-review/:jobId" element={<SeParseReviewPage />} />
      </Routes>,
      {
        route: '/admin/standard-execution/sources/src-1/parse-review/job-1',
      },
    )

    expect(await screen.findByText('解析结果确认')).toBeInTheDocument()
    expect(seGetSource).not.toHaveBeenCalled()
    expect(screen.getByText('高置信度')).toBeInTheDocument()
    expect(screen.getByText('低置信度')).toBeInTheDocument()
    await user.click(screen.getByText('门岗来访登记'))
    expect(window.HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '全选高置信度' }))
    await waitFor(() => expect(screen.getByRole('button', { name: /批量入库 1/ })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /批量入库 1/ }))

    await waitFor(() => expect(seCreateRequirement).toHaveBeenCalled())
    expect(seCreateRequirement).toHaveBeenCalledWith(expect.objectContaining({
      sourceId: 'src-1',
      title: '门岗来访登记',
      generateMode: 'AI',
      status: 'DRAFT',
    }))
    expect(await screen.findByText('已入库')).toBeInTheDocument()
  })

  it('regenerates a single draft through the parse job endpoint', async () => {
    const user = userEvent.setup()
    const nextDraft = {
      ...result.requirements[0],
      title: '门岗登记复核',
      confidence: 0.76,
      reasoning: '复用缓存上下文重新合成。',
    }
    seRegenerateParseV2Requirement.mockResolvedValueOnce({
      data: nextDraft,
      result: {
        ...result,
        requirements: [nextDraft, result.requirements[1]],
      },
    })
    renderWithProviders(
      <Routes>
        <Route path="/admin/standard-execution/sources/:sourceId/parse-review/:jobId" element={<SeParseReviewPage />} />
      </Routes>,
      {
        route: '/admin/standard-execution/sources/src-1/parse-review/job-1',
      },
    )

    expect(await screen.findByText('门岗来访登记')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: '重新生成' })[0])

    await waitFor(() => expect(seRegenerateParseV2Requirement).toHaveBeenCalledWith('job-1', 0))
    expect(await screen.findByText('门岗登记复核')).toBeInTheDocument()
  })
})
