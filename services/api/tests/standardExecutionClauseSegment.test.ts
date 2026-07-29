import { describe, expect, it } from 'vitest'
import { segmentClauses, segmentClausesByRule } from '../src/standard-execution/clauseSegment.js'

describe('standard-execution clause segmentation', () => {
  it('按数字条款号切分标准正文', () => {
    const chunks = segmentClausesByRule([
      '4.1 门岗值守',
      '门岗值守人员应核验来访人员身份并登记进出时间。',
      '4.2 巡逻检查',
      '巡逻人员应每日按路线巡查并保存巡更记录。',
    ].join('\n'))

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({
      clauseNo: '4.1',
      title: '门岗值守',
      chunkIndex: 0,
    })
    expect(chunks[1].text).toContain('巡更记录')
  })

  it('按中文条款号切分', () => {
    const chunks = segmentClausesByRule([
      '一、培训管理',
      '保安员应每季度参加岗位培训和应急处置考核。',
      '二、记录保存',
      '考核记录应保存不少于一年。',
    ].join('\n'))

    expect(chunks).toHaveLength(2)
    expect(chunks[0].clauseNo).toBe('一')
    expect(chunks[1].title).toBe('记录保存')
  })

  it('规则无法有效切分时可调用 AI fallback', async () => {
    const chunks = await segmentClauses(
      '这是一段没有显式条款编号但包含多个要求的长文本。'.repeat(80),
      {
        aiCaller: async () => JSON.stringify([
          { clauseNo: 'A', title: '人工切分 A', text: '第一段要求' },
          { clauseNo: 'B', title: '人工切分 B', text: '第二段要求' },
        ]),
      },
    )

    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ clauseNo: 'A', title: '人工切分 A', chunkIndex: 0 })
  })
})
