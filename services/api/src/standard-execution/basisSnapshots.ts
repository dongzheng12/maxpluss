export interface BasisSnapshot {
  requirementId: string
  sourceId: string
  sourceTitle: string
  sourceNo: string | null
  sourceType: string | null
  version: string | null
  clauseNo: string | null
  title: string
  requirementText: string
  executionDescription: string | null
  submitRequirement: string | null
  recommendedTaskType: string | null
  capturedAt: string
}

interface SourceForSnapshot {
  id?: string
  title?: string | null
  sourceNo?: string | null
  sourceType?: string | null
  version?: string | null
  isLatestVersion?: boolean | null
}

export interface RequirementForSnapshot {
  id: string
  sourceId: string
  clauseNo: string | null
  title: string
  requirementText: string
  executionDescription?: string | null
  submitRequirement?: string | null
  recommendedTaskType?: string | null
  source?: SourceForSnapshot | null
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function textOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function buildBasisSnapshot(
  requirement: RequirementForSnapshot,
  capturedAt = new Date(),
): BasisSnapshot {
  return {
    requirementId: requirement.id,
    sourceId: requirement.sourceId,
    sourceTitle: requirement.source?.title || requirement.sourceId,
    sourceNo: requirement.source?.sourceNo ?? null,
    sourceType: requirement.source?.sourceType ?? null,
    version: requirement.source?.version ?? null,
    clauseNo: requirement.clauseNo ?? null,
    title: requirement.title,
    requirementText: requirement.requirementText,
    executionDescription: requirement.executionDescription ?? null,
    submitRequirement: requirement.submitRequirement ?? null,
    recommendedTaskType: requirement.recommendedTaskType ?? null,
    capturedAt: capturedAt.toISOString(),
  }
}

export function buildBasisSnapshots(
  requirements: RequirementForSnapshot[],
  capturedAt = new Date(),
): BasisSnapshot[] {
  return requirements.map((requirement) => buildBasisSnapshot(requirement, capturedAt))
}

export function normalizeBasisSnapshots(value: unknown): BasisSnapshot[] {
  if (!Array.isArray(value)) return []
  const snapshots: BasisSnapshot[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const requirementId = textOrEmpty(item.requirementId)
    const sourceId = textOrEmpty(item.sourceId)
    const title = textOrEmpty(item.title)
    const requirementText = textOrEmpty(item.requirementText)
    if (!requirementId || !sourceId || !title) continue
    snapshots.push({
      requirementId,
      sourceId,
      sourceTitle: textOrEmpty(item.sourceTitle) || sourceId,
      sourceNo: textOrNull(item.sourceNo),
      sourceType: textOrNull(item.sourceType),
      version: textOrNull(item.version),
      clauseNo: textOrNull(item.clauseNo),
      title,
      requirementText,
      executionDescription: textOrNull(item.executionDescription),
      submitRequirement: textOrNull(item.submitRequirement),
      recommendedTaskType: textOrNull(item.recommendedTaskType),
      capturedAt: textOrEmpty(item.capturedAt) || new Date(0).toISOString(),
    })
  }
  return snapshots
}

export function findBasisSnapshot(value: unknown, requirementId: string | null | undefined) {
  if (!requirementId) return null
  return normalizeBasisSnapshots(value).find((snapshot) => snapshot.requirementId === requirementId) ?? null
}

export function basisSnapshotToRequirement(snapshot: BasisSnapshot) {
  return {
    id: snapshot.requirementId,
    sourceId: snapshot.sourceId,
    clauseNo: snapshot.clauseNo,
    title: snapshot.title,
    requirementText: snapshot.requirementText,
    executionDescription: snapshot.executionDescription,
    submitRequirement: snapshot.submitRequirement,
    recommendedTaskType: snapshot.recommendedTaskType,
    source: {
      id: snapshot.sourceId,
      title: snapshot.sourceTitle,
      sourceNo: snapshot.sourceNo,
      sourceType: snapshot.sourceType,
      version: snapshot.version,
    },
  }
}

type RequirementBasisFallback = {
  id: string
  sourceId: string
  source?: unknown
}

export function resolveRequirementBasis<T extends RequirementBasisFallback>(
  basisSnapshots: unknown,
  requirementId: string,
  fallback: T | null | undefined,
) {
  const snapshot = findBasisSnapshot(basisSnapshots, requirementId)
  if (snapshot) {
    const requirement = basisSnapshotToRequirement(snapshot)
    return { requirement, source: requirement.source, snapshot }
  }
  if (!fallback) return null
  return {
    requirement: fallback,
    source: fallback.source,
    snapshot: null,
  }
}
