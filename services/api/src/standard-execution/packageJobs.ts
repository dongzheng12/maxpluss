import { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { generatePackageArtifacts, type PackageOutputFile } from './packageArtifacts.js'
import type { PackageGenerationOptionsInput } from './types.js'

export type PackageJobStatus = 'QUEUED' | 'GENERATING' | 'READY' | 'FAILED'

export interface PackageGenerationJob {
  batchId: string
  enterpriseId: string
  packageId: string
  status: PackageJobStatus
  progress: number
  step: string
  error: string | null
  outputFiles: PackageOutputFile[]
  skippedAttachments: Array<{ fileName: string; fileUrl: string; reason: string }>
  createdAt: string
  updatedAt: string
}

const jobs = new Map<string, PackageGenerationJob>()

function nowIso() {
  return new Date().toISOString()
}

function makeBatchId() {
  return `se_pkg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function jobKey(packageId: string, batchId: string) {
  return `${packageId}:${batchId}`
}

function updateJob(job: PackageGenerationJob, patch: Partial<PackageGenerationJob>) {
  Object.assign(job, patch, { updatedAt: nowIso() })
}

export async function startPackageGenerationJob(
  enterpriseId: string,
  packageId: string,
  options: PackageGenerationOptionsInput,
) {
  const batchId = makeBatchId()
  const job: PackageGenerationJob = {
    batchId,
    enterpriseId,
    packageId,
    status: 'QUEUED',
    progress: 0,
    step: 'queued',
    error: null,
    outputFiles: [],
    skippedAttachments: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  }
  jobs.set(jobKey(packageId, batchId), job)

  await prisma.standardExecutionPackage.update({
    where: { id: packageId },
    data: {
      generationStatus: 'GENERATING',
      generationBatchId: batchId,
      generationOptions: options as Prisma.InputJsonValue,
      generationError: null,
    },
  })

  setImmediate(async () => {
    updateJob(job, { status: 'GENERATING', progress: 20, step: 'building artifacts' })
    try {
      const generated = await generatePackageArtifacts(enterpriseId, packageId, options)
      updateJob(job, {
        status: 'GENERATING',
        progress: 90,
        step: 'writing manifest',
        outputFiles: generated.outputFiles,
        skippedAttachments: generated.skippedAttachments,
      })
      await prisma.standardExecutionPackage.update({
        where: { id: packageId },
        data: {
          status: 'READY',
          generatedAt: new Date(),
          fileUrl: generated.fileUrl,
          format: 'FOLDER',
          generationStatus: 'READY',
          generationBatchId: batchId,
          generationOptions: options as Prisma.InputJsonValue,
          outputDir: generated.outputDir,
          outputManifest: generated.outputManifest as unknown as Prisma.InputJsonValue,
          generationError: null,
        },
      })
      updateJob(job, { status: 'READY', progress: 100, step: 'ready' })
    } catch (e) {
      const message = e instanceof Error ? e.message : '审计包生成失败'
      await prisma.standardExecutionPackage.update({
        where: { id: packageId },
        data: { generationStatus: 'FAILED', generationError: message },
      }).catch(() => undefined)
      updateJob(job, { status: 'FAILED', progress: 100, step: 'failed', error: message })
    }
  })

  return job
}

export function getPackageGenerationJob(packageId: string, batchId: string | null | undefined) {
  if (batchId) return jobs.get(jobKey(packageId, batchId)) ?? null
  const candidates = Array.from(jobs.values())
    .filter((job) => job.packageId === packageId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return candidates[0] ?? null
}

export function __resetPackageGenerationJobsForTest() {
  jobs.clear()
}
