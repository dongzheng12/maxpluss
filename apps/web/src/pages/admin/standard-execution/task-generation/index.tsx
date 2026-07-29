import { useSearchParams } from 'react-router-dom'
import TaskGenerationWorkbench from '../../../../components/se/TaskGenerationWorkbench'

export default function SeTaskGenerationPage() {
  const [params] = useSearchParams()
  return <TaskGenerationWorkbench scope="admin" initialSourceId={params.get('sourceId') || ''} />
}
