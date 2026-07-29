import { Button, Result } from 'antd'
import { useNavigate } from 'react-router-dom'

export default function NotFoundPage() {
  const nav = useNavigate()
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '80vh' }}>
      <Result
        status="404"
        title="页面不存在"
        subTitle="您访问的页面不存在，请检查地址或返回首页"
        extra={<Button type="primary" onClick={() => nav('/')}>返回首页</Button>}
      />
    </div>
  )
}
