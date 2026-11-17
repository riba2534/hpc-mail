import type { ComponentType } from 'react';
import { createBrowserRouter, Navigate, type RouteObject } from 'react-router-dom';
import { LoginPage } from '@/features/auth/login-page';
import { AuthGuard } from './auth-guard';
import { lazyWithReload } from './chunk-reload';
import { PageLoader } from './page-loader';
import { RouteErrorPage } from './route-error-page';
import {
  loadApiKeysPage,
  loadAppShell,
  loadComposePage,
  loadHostedDomainDetailPage,
  loadHostedDomainsPage,
  loadInboxPage,
  loadMailboxesPage,
  loadMessagePage,
  loadProfilePage,
  loadSentPage,
  loadStarredPage,
  loadTrashPage,
  type ModuleLoader,
  preloadable,
} from './route-modules';

/** 路由默认标签页标题；外壳读取最深一层的 handle.title，页面可用 useDocumentTitle 覆盖 */
export interface RouteHandle {
  title?: string;
}
const title = (value: string): RouteHandle => ({ title: value });

const page = <M,>(load: ModuleLoader<M>, pick: (module: M) => ComponentType) =>
  lazyWithReload(load, pick, <PageLoader />);

// 只在外壳的主内容区渲染，此时外壳 chunk 必已加载：随外壳 chunk 下发，不进登录页入口
const PageError = lazyWithReload(loadAppShell, (m) => m.PageError);
const AdminGuard = lazyWithReload(loadAppShell, (m) => m.AdminGuard);
const NotFoundPage = lazyWithReload(loadAppShell, (m) => m.NotFoundPage);

const InboxPage = page(loadInboxPage, (m) => m.InboxPage);
const MessagePage = page(loadMessagePage, (m) => m.MessagePage);
const ComposePage = page(loadComposePage, (m) => m.ComposePage);
const SentPage = page(loadSentPage, (m) => m.SentPage);
const StarredPage = page(loadStarredPage, (m) => m.StarredPage);
const TrashPage = page(loadTrashPage, (m) => m.TrashPage);
const MailboxesPage = page(loadMailboxesPage, (m) => m.MailboxesPage);
const HostedDomainsPage = page(loadHostedDomainsPage, (m) => m.HostedDomainsPage);
const HostedDomainDetailPage = page(loadHostedDomainDetailPage, (m) => m.HostedDomainDetailPage);
const ApiKeysPage = page(loadApiKeysPage, (m) => m.ApiKeysPage);
const ProfilePage = page(loadProfilePage, (m) => m.ProfilePage);
const UsersPage = page(preloadable(() => import('@/features/admin/users/users-page')), (m) => m.UsersPage);
const AdminUserMailPage = page(
  preloadable(() => import('@/features/admin/users/admin-user-mail-page')),
  (m) => m.AdminUserMailPage,
);
const AdminMailPage = page(preloadable(() => import('@/features/admin/mail/admin-mail-page')), (m) => m.AdminMailPage);
const InvitesPage = page(preloadable(() => import('@/features/admin/invites/invites-page')), (m) => m.InvitesPage);
const DomainsPage = page(preloadable(() => import('@/features/admin/domains/domains-page')), (m) => m.DomainsPage);
const AdminHostedDomainsPage = page(
  preloadable(() => import('@/features/admin/hosted-domains/admin-hosted-domains-page')),
  (m) => m.AdminHostedDomainsPage,
);
const SettingsPage = page(preloadable(() => import('@/features/admin/settings/settings-page')), (m) => m.SettingsPage);
const AuditPage = page(preloadable(() => import('@/features/admin/audit/audit-page')), (m) => m.AuditPage);
const AddressesPage = page(
  preloadable(() => import('@/features/admin/addresses/addresses-page')),
  (m) => m.AddressesPage,
);
const AdminAddressMailPage = page(
  preloadable(() => import('@/features/admin/addresses/address-mail-page')),
  (m) => m.AdminAddressMailPage,
);

export const routes: RouteObject[] = [
  {
    path: '/login',
    // 登录页静态打进入口：未登录首屏不再多一跳 chunk 请求
    element: <LoginPage />,
    errorElement: <RouteErrorPage />,
  },
  {
    path: '/',
    element: <AuthGuard />,
    errorElement: <RouteErrorPage />,
    children: [
      {
        // 无路径布局路由：页面异常与 chunk 加载失败只替换主内容区，外壳与导航保留
        errorElement: <PageError />,
        children: [
          { index: true, element: <Navigate to="/inbox" replace /> },
          { path: 'inbox', element: <InboxPage />, handle: title('收件箱') },
          { path: 'mail/:id', element: <MessagePage />, handle: title('邮件详情') },
          { path: 'compose', element: <ComposePage />, handle: title('写邮件') },
          { path: 'sent', element: <SentPage />, handle: title('已发送') },
          { path: 'starred', element: <StarredPage />, handle: title('星标') },
          { path: 'trash', element: <TrashPage />, handle: title('回收站') },
          { path: 'mailboxes', element: <MailboxesPage />, handle: title('我的邮箱') },
          { path: 'domains', element: <HostedDomainsPage />, handle: title('我的域名') },
          { path: 'domains/:id', element: <HostedDomainDetailPage />, handle: title('域名详情') },
          { path: 'api-keys', element: <ApiKeysPage />, handle: title('API Keys') },
          { path: 'profile', element: <ProfilePage />, handle: title('个人设置') },
          {
            path: 'admin',
            element: <AdminGuard />,
            children: [
              { index: true, element: <Navigate to="/admin/users" replace /> },
              { path: 'users', element: <UsersPage />, handle: title('用户管理') },
              { path: 'users/:userId/mail', element: <AdminUserMailPage />, handle: title('用户邮件') },
              { path: 'mail', element: <AdminMailPage />, handle: title('全站邮件') },
              { path: 'invites', element: <InvitesPage />, handle: title('邀请码') },
              { path: 'domains', element: <DomainsPage />, handle: title('收件域名') },
              { path: 'hosted-domains', element: <AdminHostedDomainsPage />, handle: title('托管域名') },
              { path: 'addresses', element: <AddressesPage />, handle: title('全站地址') },
              { path: 'addresses/:mailboxId/mail', element: <AdminAddressMailPage />, handle: title('地址邮件') },
              { path: 'shared-mailboxes', element: <Navigate to="/admin/addresses" replace /> },
              { path: 'settings', element: <SettingsPage />, handle: title('系统设置') },
              { path: 'audit', element: <AuditPage />, handle: title('操作审计') },
            ],
          },
          { path: '*', element: <NotFoundPage />, handle: title('页面不存在') },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
