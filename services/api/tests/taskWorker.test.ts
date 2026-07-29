import { beforeEach, describe, expect, it } from 'vitest'
import { prisma } from '../src/db.js'
import { claimNextTask, failCompareTask } from '../src/taskWorker.js'
import { cleanAll } from './factory.js'

async function createUser(id: string) {
  return prisma.appUser.create({
    data: {
      id,
      name: `用户-${id}`,
      role: 'user',
    },
  })
}

async function createTask(taskNo: string, userId: string, status: 'PENDING' | 'PROCESSING' = 'PENDING') {
  return prisma.compareTask.create({
    data: {
      taskNo,
      userId,
      documentName: `${taskNo}.txt`,
      fileType: 'txt',
      compareMode: 'ONE_TO_ONE',
      selectedStandardIds: '[]',
      status,
      priority: 2,
    },
  })
}

describe('taskWorker claim / fail guards', () => {
  beforeEach(async () => {
    await cleanAll()
  })

  it('claimNextTask 只会把同一条 PENDING 任务领取一次', async () => {
    await createUser('worker-user-1')
    await createTask('CMP-CLAIM-1', 'worker-user-1')

    const first = await claimNextTask()
    const second = await claimNextTask()

    expect(first?.taskNo).toBe('CMP-CLAIM-1')
    expect(second).toBeNull()

    const row = await prisma.compareTask.findUnique({ where: { taskNo: 'CMP-CLAIM-1' } })
    expect(row?.status).toBe('PROCESSING')
  })

  it('failCompareTask 只在 PROCESSING -> FAILED 时记录一次 compare_fail', async () => {
    await createUser('worker-user-2')
    await createTask('CMP-FAIL-1', 'worker-user-2', 'PROCESSING')

    await failCompareTask('CMP-FAIL-1', 'TEXT_INSUFFICIENT', '文字过少')
    await new Promise((resolve) => setTimeout(resolve, 30))
    await failCompareTask('CMP-FAIL-1', 'TEXT_INSUFFICIENT', '文字过少')
    await new Promise((resolve) => setTimeout(resolve, 30))

    const task = await prisma.compareTask.findUnique({ where: { taskNo: 'CMP-FAIL-1' } })
    const events = await prisma.analyticsEvent.findMany({
      where: { event: 'compare_fail' },
      orderBy: { id: 'asc' },
    })

    expect(task?.status).toBe('FAILED')
    expect(events).toHaveLength(1)
    expect(events[0]?.userId).toBe('worker-user-2')
    expect(events[0]?.props || '').toContain('CMP-FAIL-1')
  })
})
