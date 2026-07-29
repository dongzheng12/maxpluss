/**
 * Local-only SE AI mock.
 *
 * Explicitly gated by SE_AI_MOCK=1 and disabled in production. It is intended
 * for local / test POC validation when no real LLM key is configured.
 */

export function isLocalAiMockEnabled() {
  return process.env.SE_AI_MOCK === '1' && process.env.NODE_ENV !== 'production'
}

function extractQuizCount(prompt: string) {
  const m = prompt.match(/出\s*(\d+)\s*道/)
  const n = m ? Number(m[1]) : 3
  return Math.min(20, Math.max(1, Number.isFinite(n) ? n : 3))
}

function extractPackageIds(prompt: string) {
  return Array.from(new Set(
    Array.from(prompt.matchAll(/"packageId"\s*:\s*"([^"]+)"/g))
      .map((match) => match[1])
      .filter(Boolean),
  ))
}

export function buildLocalStandardAiMockResponse(prompt: string) {
  if (prompt.includes('出题专家') || prompt.includes('每道题的格式')) {
    const count = extractQuizCount(prompt)
    const isMulti = prompt.includes('多选题')
    const isTrueFalse = prompt.includes('判断题')
    const questions = Array.from({ length: count }, (_, i) => ({
      text: `本地模拟题 ${i + 1}：执行控制点时，首先应确认哪项内容？`,
      opts: isTrueFalse
        ? ['正确', '错误']
        : ['检查依据和提交材料', '跳过记录留存', '仅口头确认', isMulti ? '责任人和截止时间' : ''],
      answer: isTrueFalse ? [0] : isMulti ? [0, 3] : [0],
      exp: '本地 mock：应先确认检查依据、责任人、截止时间与提交材料。仅供参考，最终以人工审核为准。',
    })).map((q) => ({ ...q, opts: q.opts.filter(Boolean) }))
    return JSON.stringify(questions)
  }

  if (prompt.includes('"taskPackages"') || prompt.includes('严禁改变 packageId')) {
    const packageIds = extractPackageIds(prompt)
    return JSON.stringify({
      taskPackages: (packageIds.length ? packageIds : ['pkg-local-mock']).map((packageId, index) => ({
        packageId,
        title: '门岗访客登记检查包',
        description: `门岗值守人员按要求完成第 ${index + 1} 个任务包内的核验、登记和记录留存，并确认记录可追溯。`,
        submitRequirement: '提交来访登记台账或门岗系统截图。',
        taskType: 'INSPECTION_FILL',
        requiredMaterials: ['来访登记台账', '门岗系统截图'],
      })),
    })
  }

  if (prompt.includes('candidateRequirements') || prompt.includes('候选要求')) {
    return JSON.stringify({
      candidateRequirements: [
        {
          clauseNo: '4.1',
          sourceText: '门岗值守人员应核验来访人员身份，登记姓名、单位、联系方式、来访事由和进出时间。',
          action: '门岗核验来访人员身份并完整登记进出信息',
          responsibleRole: '门岗值守人员',
          evidenceType: '来访登记台账或门岗系统截图',
          frequency: '每次来访',
          riskLevel: 'MEDIUM',
          suggestedTaskType: 'INSPECTION_FILL',
          score: 88,
          mergeable: true,
          mergeReason: '可与门岗登记要求合并为门岗值守检查包',
        },
        {
          clauseNo: '5.3',
          sourceText: '保安员应每季度参加岗位培训和应急处置考核，考核记录应保存不少于一年。',
          action: '组织保安员完成季度岗位培训和应急处置考核',
          responsibleRole: '培训负责人',
          evidenceType: '培训签到表、考核成绩单、培训课件',
          frequency: '每季度',
          riskLevel: 'HIGH',
          suggestedTaskType: 'TRAINING',
          score: 92,
          mergeable: true,
          mergeReason: '培训、考核、记录保存可合并为培训考核任务包',
        },
      ],
    })
  }

  if (prompt.includes('提取所有可执行的要求项') || prompt.includes('可落地执行描述')) {
    return JSON.stringify([
      {
        clauseNo: '4.1',
        title: '记录留存',
        requirementText: '企业应建立并保存标准执行记录，记录应包含责任人、时间、结果和整改情况。',
        executionDescription: '核查是否已建立执行记录台账，确认每条记录包含责任人、执行时间、检查结果和整改状态；执行时上传台账截图或记录文件。',
        recommendedTaskType: 'INSPECTION_FILL',
        suggestedDepartment: '质量部',
        suggestedFrequency: 'MONTHLY',
        submitRequirement: '上传执行记录台账或截图',
        requiredMaterials: ['执行记录台账', '检查截图'],
      },
      {
        clauseNo: '4.2',
        title: '培训确认',
        requirementText: '相关岗位人员应接受标准执行培训并通过考核。',
        executionDescription: '组织相关岗位人员完成标准执行培训，收集签到、学习材料和考核结果；执行时上传培训证明。',
        recommendedTaskType: 'TRAINING',
        suggestedDepartment: '人事行政部',
        suggestedFrequency: 'QUARTERLY',
        submitRequirement: '上传培训签到表和考核结果',
        requiredMaterials: ['培训签到表', '考核结果'],
      },
    ])
  }

  return '本地 mock：我已结合当前页面上下文给出执行建议。请优先确认适用检查点、责任人、截止时间和需提交材料；如涉及审核结论，以企业审核人为准。仅供参考，最终以人工审核为准。'
}

export function buildLocalSEChatReply(message: string, contextSummary: string) {
  if (/未覆盖|没有覆盖|尚未覆盖|覆盖.*哪些/.test(message)) {
    const countMatch = contextSummary.match(/未覆盖控制点：共\s*(\d+)\s*条/)
    const block = contextSummary.match(/未覆盖控制点：共[^\n]*\n([\s\S]*?)\n\n【你的职责】/)
    const rows = block?.[1]
      ?.split('\n')
      .map((line) => line.replace(/^\s*•\s*/, '').trim())
      .filter((line) => line && !line.includes('暂无未覆盖控制点'))
      .slice(0, 8) || []
    const count = countMatch?.[1] || String(rows.length)
    if (rows.length === 0) {
      return `本地 mock：当前未发现未覆盖控制点。仅供参考，最终以人工审核为准。`
    }
    return `本地 mock：当前共有 ${count} 个未覆盖控制点，优先关注：\n${rows.map((row, index) => `${index + 1}. ${row}`).join('\n')}\n仅供参考，最终以人工审核为准。`
  }
  const ownedMatch = contextSummary.match(/【O档自有文档上下文[\s\S]*?【来源】([^\n]+)\n【节选】\n"""([\s\S]*?)"""/)
  if (ownedMatch) {
    const sourceTitle = ownedMatch[1].trim()
    const firstLine = ownedMatch[2]
      .split(/\n+/)
      .map(line => line.trim())
      .find(Boolean)
      ?.slice(0, 180)
    if (firstLine) {
      return `本地 mock：根据《${sourceTitle}》节选，${firstLine}。仅供参考，最终以人工审核为准。`
    }
  }
  const taskHint = contextSummary.includes('任务概况') ? '当前企业已有标准执行任务数据，建议先查看进行中任务和待审核提交。' : '当前页面上下文较少，建议先选择具体标准来源或检查点。'
  return `本地 mock：收到「${message.slice(0, 80)}」。${taskHint} 可按“检查点要求 → 执行动作 → 提交材料 → 审核记录”的顺序推进。仅供参考，最终以人工审核为准。`
}
