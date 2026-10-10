import type { ComponentType } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { LoginPage } from '@/features/auth/login-page';
import { AdminGuard } from './admin-guard';
import { AuthGuard } from './auth-guard';
import { lazyWithReload } from './chunk-reload';
import { NotFoundPage } from './not-found-page';
import { PageLoader } from './page-loader';
import { RouteErrorPage } from './route-error-page';
import {
  loadApiKeysPage,
  loadComposePage,
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

const page = <M,>(load: ModuleLoader<M>, pick: (module: M) => ComponentType) =>
  lazyWithReload(load, pick, <PageLoader />);

const InboxPage = page(loadInboxPage, (m) => m.InboxPage);
const MessagePage = page(loadMessagePage, (m) => m.MessagePage);
const ComposePage = page(loadComposePage, (m) => m.ComposePage);
const SentPage = page(loadSentPage, (m) => m.SentPage);
const StarredPage = page(loadStarredPage, (m) => m.StarredPage);
const TrashPage = page(loadTrashPage, (m) => m.TrashPage);
const MailboxesPage = page(loadMailboxesPage, (m) => m.MailboxesPage);
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
const SettingsPage = page(preloadable(() => import('@/features/admin/settings/settings-page')), (m) => m.SettingsPage);
const AuditPage = page(preloadable(() => import('@/features/admin/audit/audit-page')), (m) => m.AuditPage);
const AddressesPage = page(
  preloadable(() => import('@/features/admin/addresses/addresses-page')),
  (m) => m.AddressesPage,
);
const SharedMailboxesPage = page(
  preloadable(() => import('@/features/admin/shared-mailboxes/shared-mailboxes-page')),
  (m) => m.SharedMailboxesPage,
);

export const router = createBrowserRouter([
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
      { index: true, element: <Navigate to="/inbox" replace /> },
      { path: 'inbox', element: <InboxPage /> },
      { path: 'mail/:id', element: <MessagePage /> },
      { path: 'compose', element: <ComposePage /> },
      { path: 'sent', element: <SentPage /> },
      { path: 'starred', element: <StarredPage /> },
      { path: 'trash', element: <TrashPage /> },
      { path: 'mailboxes', element: <MailboxesPage /> },
      { path: 'api-keys', element: <ApiKeysPage /> },
      { path: 'profile', element: <ProfilePage /> },
      {
        path: 'admin',
        element: <AdminGuard />,
        children: [
          { index: true, element: <Navigate to="/admin/users" replace /> },
          { path: 'users', element: <UsersPage /> },
          { path: 'users/:userId/mail', element: <AdminUserMailPage /> },
          { path: 'mail', element: <AdminMailPage /> },
          { path: 'invites', element: <InvitesPage /> },
          { path: 'domains', element: <DomainsPage /> },
          { path: 'addresses', element: <AddressesPage /> },
          { path: 'shared-mailboxes', element: <SharedMailboxesPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'audit', element: <AuditPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
