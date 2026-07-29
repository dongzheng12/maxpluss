import { useSearchParams } from 'react-router-dom'
import WorkbenchV2 from '../../../components/se/workbenchV2/WorkbenchV2'

export default function EnterpriseWorkbenchPage() {
  const [params] = useSearchParams()
  return <WorkbenchV2 scope="enterprise" initialSourceId={params.get('sourceId') || ''} />
}
