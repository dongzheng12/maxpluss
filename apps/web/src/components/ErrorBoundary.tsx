/**
 * P0-7: 全局 ErrorBoundary
 * 捕获任意子组件渲染错误，防止白屏；展示可操作的错误提示
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  message: string
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error?.message || '未知错误' }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  handleReset = () => {
    this.setState({ hasError: false, message: '' })
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '60vh',
          padding: '40px 24px',
          textAlign: 'center'
        }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ marginBottom: 8, color: '#1a1a2e' }}>页面加载异常</h2>
          <p style={{ color: '#666', marginBottom: 24, maxWidth: 400 }}>
            {this.state.message || '页面发生错误，请点击刷新重试。如果问题持续，请联系客服。'}
          </p>
          <button
            onClick={this.handleReset}
            style={{
              padding: '10px 28px',
              background: '#245df4',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 15,
              fontWeight: 600
            }}
          >
            刷新页面
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
