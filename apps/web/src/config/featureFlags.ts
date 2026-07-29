/**
 * 前端 feature flag（构建时由 Vite 注入 import.meta.env.VITE_*）
 */

// SE（标准执行 / 企业版）模块 UI 入口总开关。
// 用途：SE 模块首次上生产期间灰度 —— 代码 / 路由 / DB 表结构可先上生产，但入口默认不暴露给普通用户。
// 取值：
//   - 企业版上线 build：设 VITE_SE_UI_ENABLED=true → 开放 SE 入口
//   - 未配置（默认 false）→ SE 菜单 / 企业版登录 tab / 问小智浮标 全部隐藏
// 不影响：个人版、标准查询、文档比对、admin 其他菜单（仅隐藏 SE 入口，后端能力不变）
export const SE_UI_ENABLED = import.meta.env.VITE_SE_UI_ENABLED === 'true'

// 任务生成工作台 v2 兜底切回开关。
// 默认（未配置 / 非 'true'）：v2 工作台接管「任务生成」入口（导航 + /enterprise 主入口指向 /enterprise/workbench）。
// 设 VITE_SE_WORKBENCH_LEGACY=true：导航「任务生成」指回旧 4-step 工作台 /enterprise/task-generation。
// 重要：本 flag 只控制「导航 + 主入口指向谁」，不控制旧组件是否存在。
//   旧 task-generation 路由/组件无条件常驻 bundle（见 App.tsx），翻车时第一时间可直接发旧 URL 顶，零部署。
export const SE_WORKBENCH_LEGACY = import.meta.env.VITE_SE_WORKBENCH_LEGACY === 'true'
