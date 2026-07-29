import { useEffect } from 'react'
import { DatePicker, Form, Input, InputNumber, Modal, Radio, Select } from 'antd'
import dayjs from 'dayjs'
import { STANDARD_TASK_TYPE_VALUES, TASK_TYPE_LABEL, type TaskCardV2 } from '../../../api/standardExecution'
import type { CardEditablePatch } from './model'

const { TextArea } = Input

const TASK_TYPE_OPTIONS = STANDARD_TASK_TYPE_VALUES.map((value) => ({ value, label: TASK_TYPE_LABEL[value] || value }))

interface EditCardModalProps {
  card: TaskCardV2 | null
  open: boolean
  onCancel: () => void
  onSave: (cardId: string, patch: CardEditablePatch) => void
}

interface FormShape {
  title: string
  taskType: string
  description: string
  submitRequirement: string
  requiredMaterials: string[]
  deadlineMode: 'FIXED' | 'AFTER_APPROVAL_DAYS'
  daysAfterApproval: number | null
  fixedAt: dayjs.Dayjs | null
}

export default function EditCardModal({ card, open, onCancel, onSave }: EditCardModalProps) {
  const [form] = Form.useForm<FormShape>()
  // 从表单字段派生当前截止模式，避免在 effect 里 setState（react-hooks/set-state-in-effect）
  const mode = (Form.useWatch('deadlineMode', form) as FormShape['deadlineMode']) || 'AFTER_APPROVAL_DAYS'

  useEffect(() => {
    if (!card || !open) return
    const d = card.deadlineSuggestion
    form.setFieldsValue({
      title: card.title,
      taskType: card.taskType,
      description: card.description,
      submitRequirement: card.submitRequirement,
      requiredMaterials: card.requiredMaterials || [],
      deadlineMode: d.mode,
      daysAfterApproval: d.daysAfterApproval ?? 30,
      fixedAt: d.fixedAt ? dayjs(d.fixedAt) : null,
    })
  }, [card, open, form])

  const handleOk = async () => {
    if (!card) return
    const values = await form.validateFields()
    const patch: CardEditablePatch = {
      title: values.title.trim(),
      taskType: values.taskType,
      description: values.description.trim(),
      submitRequirement: values.submitRequirement.trim(),
      requiredMaterials: (values.requiredMaterials || []).filter(Boolean),
      deadlineSuggestion: {
        mode: values.deadlineMode,
        daysAfterApproval: values.deadlineMode === 'AFTER_APPROVAL_DAYS' ? values.daysAfterApproval ?? 30 : null,
        fixedAt: values.deadlineMode === 'FIXED' ? (values.fixedAt ? values.fixedAt.toISOString() : null) : null,
      },
    }
    onSave(card.id, patch)
  }

  return (
    <Modal title="编辑任务卡" open={open} onOk={handleOk} onCancel={onCancel} okText="保存" cancelText="取消" width={640} destroyOnClose>
      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item label="任务标题" name="title" rules={[{ required: true, message: '标题不能为空' }, { max: 80 }]}>
          <Input maxLength={80} placeholder="动词开头的可执行标题" />
        </Form.Item>
        <Form.Item label="任务类型" name="taskType" rules={[{ required: true, message: '请选择类型' }]}>
          <Select options={TASK_TYPE_OPTIONS} placeholder="任务类型" />
        </Form.Item>
        <Form.Item label="执行说明" name="description" rules={[{ max: 2000 }]}>
          <TextArea rows={3} maxLength={2000} showCount placeholder="员工需要怎么做" />
        </Form.Item>
        <Form.Item label="提交要求" name="submitRequirement" rules={[{ max: 1000 }]}>
          <TextArea rows={2} maxLength={1000} showCount placeholder="员工需提交什么材料" />
        </Form.Item>
        <Form.Item label="需提交材料" name="requiredMaterials">
          <Select mode="tags" tokenSeparators={[',', '，', '\n']} placeholder="输入后回车，可多个" />
        </Form.Item>
        <Form.Item label="截止建议" name="deadlineMode">
          <Radio.Group>
            <Radio value="AFTER_APPROVAL_DAYS">审核通过后 N 天</Radio>
            <Radio value="FIXED">固定日期</Radio>
          </Radio.Group>
        </Form.Item>
        {mode === 'AFTER_APPROVAL_DAYS' ? (
          <Form.Item label="天数" name="daysAfterApproval">
            <InputNumber min={1} max={3650} addonAfter="天" style={{ width: 160 }} />
          </Form.Item>
        ) : (
          <Form.Item label="截止日期" name="fixedAt">
            <DatePicker showTime style={{ width: 240 }} />
          </Form.Item>
        )}
      </Form>
    </Modal>
  )
}
