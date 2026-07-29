import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { reactClickToComponent } from 'vite-plugin-react-click-to-component'

export default defineConfig({
  plugins: [react(), tailwindcss(), reactClickToComponent()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    // pnpm workspace 自动 dedupe react/react-dom；不硬编码绝对路径，防 CI pnpm 环境找不到
    dedupe: ['react', 'react-dom'],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react-dom') || id.includes('node_modules/react/') || id.includes('node_modules/react-router')) return 'vendor-react'
          if (id.includes('node_modules/antd') || id.includes('node_modules/@ant-design')) return 'vendor-antd'
          if (id.includes('node_modules/axios') || id.includes('node_modules/dayjs')) return 'vendor-utils'
          if (id.includes('node_modules/jspdf') || id.includes('node_modules/html2canvas')) return 'vendor-pdf'
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // ── 比对/识别相关 → 生产 Node API（依赖 dedup，本地无法调用）──
      // 任务列表/详情必须走本地：本地登录 token 对生产 API 无效，否则个人版比对页会 401。
      '/node-api/api/app/compare/tasks':    { target: 'http://localhost:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/node-api/, '') },
      '/node-api/api/app/compare':          { target: 'https://api.biaozhunxiaozhi.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/node-api/, '') },
      '/node-api/api/app/recognize':        { target: 'https://api.biaozhunxiaozhi.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/node-api/, '') },
      // '/node-api/api/admin/compare-tasks': 不再单独代理，统一走 localhost:3000
      // ── 其他 Node API → 本地（用户/订单/会员/赠送/发票/预约/管理后台）──
      '/node-api':                          { target: 'http://localhost:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/node-api/, '') },
      // ── 上传资源（头像/二维码）→ 本地 Node（生产 nginx 直接 serve）──
      '/uploads':                           { target: 'http://localhost:3000', changeOrigin: true },
      // ── Python API → 生产（标准检索/图谱/委员会，本地无 487K 数据）──
      '/py-api':                            { target: 'https://api.biaozhunxiaozhi.com', changeOrigin: true, secure: true, rewrite: (p) => p.replace(/^\/py-api/, '') },
    },
  },
})
