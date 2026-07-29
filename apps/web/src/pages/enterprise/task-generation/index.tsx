import { useSearchParams } from 'react-router-dom'
import TaskGenerationWorkbench from '../../../components/se/TaskGenerationWorkbench'

export default function EnterpriseTaskGenerationPage() {
  const [params] = useSearchParams()
  return <TaskGenerationWorkbench scope="enterprise" initialSourceId={params.get('sourceId') || ''} />
}
