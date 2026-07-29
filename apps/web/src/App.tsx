import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useRef } from 'react'
import { trackPageView, trackLandingArrive } from './utils/tracker'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import { AuthProvider } from './contexts/AuthContext'
import { ContactSalesProvider } from './contexts/ContactSalesContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ProtectedRoute } from './components/ProtectedRoute'
import { EnterpriseRoute } from './components/EnterpriseRoute'

import UserLayout from './layouts/UserLayout'
import AdminLayout from './layouts/AdminLayout'
import SalesLayout from './layouts/SalesLayout'
import EnterpriseLayout from './layouts/EnterpriseLayout'
import { SE_UI_ENABLED } from './config/featureFlags'

import HomePage from './pages/home'
import StandardsPage from './pages/standards'
import DetailPage from './pages/detail'
import ComparePage from './pages/compare'
import CompareReportPage from './pages/compare-report'
import CommitteePage from './pages/committee'
import GraphPage from './pages/graph'
import OutlinePage from './pages/outline'
import BookingPage from './pages/booking'
import OrdersPage from './pages/orders'
import InvoicesPage from './pages/invoices'
import ProfilePage from './pages/profile'
import MyCouponsPage from './pages/coupons'
import FavoritesPage from './pages/favorites'
import MembershipPage from './pages/membership'
import BenefitsPage from './pages/membership/benefits'
import LoginPage from './pages/login'
import RegisterPage from './pages/register'
import ForgotPasswordPage from './pages/forgot-password'

import AdminDashboard from './pages/admin/dashboard'
import AdminUsersPage from './pages/admin/users'
import AdminOrdersPage from './pages/admin/orders'
import AdminStandardsPage from './pages/admin/standards'
import AdminInvoicesPage from './pages/admin/invoices'
import AdminBookingsPage from './pages/admin/bookings'
import AdminExpertVotesPage from './pages/admin/expert-votes'
import AdminExpertVoteDetailPage from './pages/admin/expert-votes/detail'
import ExpertVoteListPage from './pages/expert-vote'
import ExpertVoteNewPage from './pages/expert-vote/new'
import ExpertVoteDetailPage from './pages/expert-vote/detail'
import ExpertVoteMeetingPage from './pages/expert-vote/meeting'
import AdminCompareTasksPage from './pages/admin/compare-tasks'
import AdminAdminsPage from './pages/admin/admins'
import AdminGiftsPage from './pages/admin/gifts'
import AdminSalesPage from './pages/admin/sales'
import AdminAnnouncementsPage from './pages/admin/announcements'
import AdminContentConfigPage from './pages/admin/content-config'
import AdminCouponsPage from './pages/admin/coupons'
import AdminSettingsPage from './pages/admin/settings'
import AdminEnterpriseApplicationsPage from './pages/admin/enterprise-applications'
import SeDashboardPage from './pages/admin/standard-execution/dashboard'
import SeIntelligenceDashboardPage from './pages/admin/standard-execution/intelligence-dashboard'
import SeStandardLibraryPage from './pages/admin/standard-execution/library'
import SeParseReviewPage from './pages/admin/standard-execution/parse-review'
import SeRequirementsPage from './pages/admin/standard-execution/requirements'
import SeTaskGenerationPage from './pages/admin/standard-execution/task-generation'
import SeTasksPage from './pages/admin/standard-execution/tasks'
import SePlansPage from './pages/admin/standard-execution/plans'
import SeReviewsPage from './pages/admin/standard-execution/reviews'
import SeRecordsPage from './pages/admin/standard-execution/records'
import SePackagesPage from './pages/admin/standard-execution/packages'
import SeRisksPage from './pages/admin/standard-execution/risks'
import SeQuestionBanksPage from './pages/admin/standard-execution/question-banks'
import SeIndustryTemplatesPage from './pages/admin/standard-execution/industry-templates'
import AdminLoginPage from './pages/admin/login'
import EnterpriseMembersPage from './pages/enterprise/members'
import EnterpriseAiAssistantPage from './pages/enterprise/ai-assistant'
import EnterpriseMyTasksPage from './pages/enterprise/my-tasks'
import EnterpriseOpenApiPage from './pages/enterprise/open-api'
import EnterpriseComplianceMatrixPage from './pages/enterprise/compliance-matrix'
import EnterpriseTaskGenerationPage from './pages/enterprise/task-generation'
import EnterpriseWorkbenchPage from './pages/enterprise/workbench'
import AdminRolesPage from './pages/admin/roles'
import AdminSalesWorkspacePage from './pages/admin/sales/workspace'
import AdminSalesOverviewPage from './pages/admin/sales/overview'
import { PermissionProvider, PermissionRouteRefresher } from './contexts/PermissionContext'
import TermsPage from './pages/terms'
import PrivacyPage from './pages/privacy'
import ClaimPage from './pages/claim'
import NotFoundPage from './pages/not-found'
import AnnouncementsPage from './pages/announcements'
import ChatPage from './pages/chat'
import ReferralPage from './pages/referral'
import SalesProfilePage from './pages/sales-profile'
import SalesLandingPage from './pages/sales-landing'
import ProductBxzPage from './pages/product-biaozhunxiaozhi'
import SalesJoinPage from './pages/sales-join'
import SalesDashboardPage from './pages/sales-dashboard'
import SalesDataPage from './pages/sales-data'
import SalesMaterialPage from './pages/sales-material'
import { captureReferralFromUrl } from './utils/referral'


function RouteTracker() {
  const location = useLocation()
  const isFirst = useRef(true)
  useEffect(() => {
    trackPageView(location.pathname)
    if (isFirst.current) {
      trackLandingArrive()
      // 裂变归因：早期捕获 ?ref=<code> 到 localStorage，待登录/注册成功后消费
      captureReferralFromUrl()
      isFirst.current = false
    }
  }, [location.pathname])
  return null
}

export default function App() {
  return (
    <ErrorBoundary>
    <ConfigProvider locale={zhCN} theme={{ token: { borderRadius: 8, zIndexPopupBase: 1300 } }}>
      <AuthProvider>
        <PermissionProvider>
        <BrowserRouter>
          <RouteTracker />
          <PermissionRouteRefresher />
          <ContactSalesProvider>
          <Routes>
            {/* User-facing（UserLayout 内：仅 /referral 公开；其余全锁） */}
            <Route element={<UserLayout />}>
              {/* 公开白名单 */}
              <Route path="/referral" element={<ReferralPage />} />

              {/* 全部需要登录 — 命中即跳 /login?redirect=... */}
              <Route element={<ProtectedRoute />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/standards" element={<StandardsPage />} />
                <Route path="/standards/:code" element={<DetailPage />} />
                <Route path="/compare" element={<ComparePage />} />
                <Route path="/compare/report/:taskNo" element={<CompareReportPage />} />
                <Route path="/committee" element={<CommitteePage />} />
                <Route path="/graph" element={<GraphPage />} />
                <Route path="/industry" element={<Navigate to="/standards?mode=industry" replace />} />
                <Route path="/outline" element={<OutlinePage />} />
                <Route path="/booking" element={<BookingPage />} />
                <Route path="/announcements" element={<AnnouncementsPage />} />
                <Route path="/chat" element={<ChatPage />} />
                <Route path="/expert-vote" element={<ExpertVoteListPage />} />
                <Route path="/expert-vote/new" element={<ExpertVoteNewPage />} />
                <Route path="/expert-vote/:no" element={<ExpertVoteDetailPage />} />
                <Route path="/expert-vote/:no/meeting" element={<ExpertVoteMeetingPage />} />
                <Route path="/orders" element={<OrdersPage />} />
                <Route path="/invoices" element={<InvoicesPage />} />
                <Route path="/coupons" element={<MyCouponsPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route path="/favorites" element={<FavoritesPage />} />
                <Route path="/membership" element={<MembershipPage />} />
                <Route path="/membership/benefits" element={<BenefitsPage />} />
              </Route>
            </Route>

            {/* 白名单 standalone（无需登录） */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/s/:salesCode" element={<SalesLandingPage />} />
            <Route path="/sales/join" element={<SalesJoinPage />} />
            <Route path="/admin/login" element={<AdminLoginPage />} />
            {SE_UI_ENABLED && <Route path="/enterprise/login" element={<Navigate to="/login?tab=enterprise" replace />} />}

            {/* 企业版独立门户 — 复用 admin SE 8 个页面组件，套 EnterpriseLayout。SE 灰度：flag 关时整块不挂，URL 直达落 404 */}
            {SE_UI_ENABLED && (
            <Route element={<EnterpriseRoute />}>
              <Route path="/enterprise" element={<EnterpriseLayout />}>
                <Route index element={<Navigate to="/enterprise/dashboard" replace />} />
                <Route path="dashboard" element={<SeDashboardPage />} />
                <Route path="intelligence-dashboard" element={<SeIntelligenceDashboardPage />} />
                <Route path="compliance-matrix" element={<EnterpriseComplianceMatrixPage />} />
                <Route path="sources" element={<SeStandardLibraryPage />} />
                <Route path="requirements" element={<SeRequirementsPage />} />
                {/* v2 任务生成工作台（接管入口）。旧 task-generation 路由无条件常驻于下，作兜底切回 */}
                <Route path="workbench" element={<EnterpriseWorkbenchPage />} />
                <Route path="task-generation" element={<EnterpriseTaskGenerationPage />} />
                <Route path="tasks" element={<SeTasksPage />} />
                <Route path="plans" element={<SePlansPage />} />
                <Route path="reviews" element={<SeReviewsPage />} />
                <Route path="records" element={<SeRecordsPage />} />
                <Route path="packages" element={<SePackagesPage />} />
                <Route path="risks" element={<SeRisksPage />} />
                <Route path="question-banks" element={<SeQuestionBanksPage />} />
                <Route path="members" element={<EnterpriseMembersPage />} />
                <Route path="open-api" element={<EnterpriseOpenApiPage />} />
                <Route path="ai-assistant" element={<EnterpriseAiAssistantPage />} />
                <Route path="my-tasks" element={<EnterpriseMyTasksPage />} />
              </Route>
            </Route>
            )}

            {/* standalone 但需要登录 */}
            <Route element={<ProtectedRoute />}>
              <Route path="/claim/:code" element={<ClaimPage />} />
              <Route path="/product/biaozhunxiaozhi" element={<ProductBxzPage />} />
            </Route>

            {/* Sales 工作台（独立 Layout，不套主应用导航） */}
            <Route element={
              <ProtectedRoute requiredRole="sales">
                <SalesLayout />
              </ProtectedRoute>
            }>
              <Route path="/sales/dashboard" element={<SalesDashboardPage />} />
              <Route path="/sales/profile" element={<SalesProfilePage />} />
              <Route path="/sales/material" element={<SalesMaterialPage />} />
              <Route path="/sales/data" element={<SalesDataPage />} />
            </Route>

            {/* Admin */}
            <Route path="/admin" element={
              <ProtectedRoute requiredRole="admin">
                <AdminLayout />
              </ProtectedRoute>
            }>
              <Route index element={<AdminDashboard />} />
              <Route path="users" element={<AdminUsersPage />} />
              <Route path="orders" element={<AdminOrdersPage />} />
              <Route path="standards" element={<AdminStandardsPage />} />
              <Route path="invoices" element={<AdminInvoicesPage />} />
              <Route path="bookings" element={<AdminBookingsPage />} />
              <Route path="expert-votes" element={<AdminExpertVotesPage />} />
              <Route path="expert-votes/:no" element={<AdminExpertVoteDetailPage />} />
              <Route path="compare-tasks" element={<AdminCompareTasksPage />} />
              <Route path="admins" element={<AdminAdminsPage />} />
              <Route path="gifts" element={<AdminGiftsPage />} />
              <Route path="sales" element={<AdminSalesPage />} />
              <Route path="announcements" element={<AdminAnnouncementsPage />} />
              <Route path="content-config" element={<AdminContentConfigPage />} />
              <Route path="coupons" element={<AdminCouponsPage />} />
              <Route path="settings" element={<AdminSettingsPage />} />
              <Route path="enterprise-applications" element={<AdminEnterpriseApplicationsPage />} />
              {/* 我的推广主页：Tabs 容器（推广资料/推广素材/订单数据） */}
              <Route path="sales/workspace" element={<AdminSalesWorkspacePage />} />
              {/* 销售数据看板：admin only，sales 角色访问由 ProtectedRoute 拦截 */}
              <Route path="sales/overview" element={<AdminSalesOverviewPage />} />
              {/* 旧子路径保留兼容（外链/书签），不再作为菜单入口 */}
              <Route path="sales/profile" element={<SalesProfilePage />} />
              <Route path="sales/material" element={<SalesMaterialPage />} />
              <Route path="sales/data" element={<SalesDataPage />} />
              <Route path="roles" element={<AdminRolesPage />} />
              {/* SE 灰度：flag 关时这些 route 不挂，/admin/standard-execution/* 直达落 404 */}
              {SE_UI_ENABLED && (<>
              <Route path="standard-execution/dashboard" element={<SeDashboardPage />} />
              <Route path="standard-execution/intelligence-dashboard" element={<SeIntelligenceDashboardPage />} />
              <Route path="standard-execution/sources" element={<SeStandardLibraryPage />} />
              <Route path="standard-execution/sources/:sourceId/parse-review/:jobId" element={<SeParseReviewPage />} />
              <Route path="standard-execution/requirements" element={<Navigate to="/admin/standard-execution/sources" replace />} />
              <Route path="standard-execution/task-generation" element={<SeTaskGenerationPage />} />
              <Route path="standard-execution/tasks" element={<SeTasksPage />} />
              <Route path="standard-execution/reviews" element={<SeReviewsPage />} />
              <Route path="standard-execution/records" element={<SeRecordsPage />} />
              <Route path="standard-execution/packages" element={<SePackagesPage />} />
              <Route path="standard-execution/risks" element={<SeRisksPage />} />
              <Route path="standard-execution/question-banks" element={<SeQuestionBanksPage />} />
              <Route path="standard-execution/industry-templates" element={<SeIndustryTemplatesPage />} />
              </>)}
            </Route>
            {/* 404 */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
          </ContactSalesProvider>
        </BrowserRouter>
        </PermissionProvider>
      </AuthProvider>
    </ConfigProvider>
    </ErrorBoundary>
  )
}
