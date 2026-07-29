import { describe, expect, it } from 'vitest'
import {
  TASK_DETAIL_FIELD_KEYS,
  TASK_EDIT_FIELD_KEYS,
  TASK_FIELD_MODEL,
  buildSubmitFormConfigPreview,
  getTaskFieldEditPolicy,
  submitConfigForTask,
} from './taskFieldModel'

describe('task field model', () => {
  it('keeps detail and edit projections on the same field set', () => {
    expect(TASK_FIELD_MODEL.map((field) => field.key)).toEqual([
      'title',
      'taskType',
      'source',
      'generatedContent',
      'assignees',
      'reviewer',
      'deadline',
      'submitForm',
      'submitRequirement',
      'materials',
      'status',
      'lifecycle',
    ])
    expect(TASK_DETAIL_FIELD_KEYS).toEqual(TASK_EDIT_FIELD_KEYS)
    expect(TASK_DETAIL_FIELD_KEYS).toHaveLength(12)
  })

  it('locks published task editing in the UI contract', () => {
    const policy = getTaskFieldEditPolicy('PUBLISHED')
    expect(policy.title.editable).toBe(false)
    expect(policy.generatedContent.editable).toBe(false)
    expect(policy.submitRequirement.editable).toBe(false)
    expect(policy.deadline.editable).toBe(false)
    expect(policy.reviewer.editable).toBe(false)
    expect(policy.assignees.editable).toBe(false)
    expect(policy.assignees.reason).toContain('不可编辑')
    expect(policy.taskType.editable).toBe(false)
    expect(policy.submitForm.editable).toBe(false)
    expect(policy.lifecycle.editable).toBe(false)
  })

  it('mirrors T12 submit form defaults for attachment and task item modes', () => {
    const photo = buildSubmitFormConfigPreview({ taskType: 'PHOTO' })
    expect(photo.modes).toEqual(expect.arrayContaining(['TEXT', 'ATTACHMENT']))
    expect(photo.attachment).toMatchObject({ required: true, minCount: 1, accept: ['image/*'] })
    expect(photo.employeeHint).toContain('上传必需附件')

    const taskItems = buildSubmitFormConfigPreview({ taskType: 'OTHER', taskItemCount: 3 })
    expect(taskItems.modes).toEqual(expect.arrayContaining(['TASK_ITEMS']))
    expect(taskItems.structured).toEqual({ type: 'TASK_ITEMS', itemCount: 3 })
  })

  it('normalizes partial legacy submit form configs before rendering', () => {
    const normalized = submitConfigForTask({
      taskType: 'PHOTO',
      submitFormConfig: {
        version: 'T12_SUBMIT_FORM_V1',
        mode: 'ATTACHMENT',
        attachment: { required: true, minCount: 2 },
      },
    } as never)

    expect(normalized.modes).toEqual(expect.arrayContaining(['TEXT', 'ATTACHMENT']))
    expect(normalized.text.label).toBe('提交说明')
    expect(normalized.attachment).toMatchObject({ required: true, minCount: 2, accept: ['image/*'] })
    expect(normalized.structured).toEqual({ type: null, itemCount: 0 })
  })
})
