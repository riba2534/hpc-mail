import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AdminGuard } from './admin-guard';
import { AuthGuard } from './auth-guard';
import { FullScreenLoader } from './page-loader';
import { NotFoundPage } from './not-found-page';
import { RouteErrorPage } from './route-error-page';

const LoginPage = lazy(() => import('@/features/auth/login-page').then((m) => ({ default: m.LoginPage })));
const InboxPage = lazy(() => import('@/features/inbox/inbox-page').then((m) => ({ default: m.InboxPage })));
const MessagePage = lazy(() => import('@/features/message/message-page').then((m) => ({ default: m.MessagePage })));
const ComposePage = lazy(() => import('@/features/compose/compose-page').then((m) => ({ default: m.ComposePage })));
const SentPage = lazy(() => import('@/features/sent/sent-page').then((m) => ({ default: m.SentPage })));
const StarredPage = lazy(() =>
  import('@/features/starred/starred-page').then((m) => ({ default: m.StarredPage })),
);
const TrashPage = lazy(() =>
  import('@/features/trash/trash-page').then((m) => ({ default: m.TrashPage })),
);
const MailboxesPage = lazy(() =>
  import('@/features/mailboxes/mailboxes-page').then((m) => ({ default: m.MailboxesPage })),
);
const ApiKeysPage = lazy(() => import('@/features/api-keys/api-keys-page').then((m) => ({ default: m.ApiKeysPage })));
const ProfilePage = lazy(() => import('@/features/profile/profile-page').then((m) => ({ default: m.ProfilePage })));
const UsersPage = lazy(() => import('@/features/admin/users/users-page').then((m) => ({ default: m.UsersPage })));
const AdminUserMailPage = lazy(() =>
  import('@/features/admin/users/admin-user-mail-page').then((m) => ({ default: m.AdminUserMailPage })),
);
const AdminMailPage = lazy(() =>
  import('@/features/admin/mail/admin-mail-page').then((m) => ({ default: m.AdminMailPage })),
);
const InvitesPage = lazy(() =>
  import('@/features/admin/invites/invites-page').then((m) => ({ default: m.InvitesPage })),
);
const DomainsPage = lazy(() =>
  import('@/features/admin/domains/domains-page').then((m) => ({ default: m.DomainsPage })),
);
const SettingsPage = lazy(() =>
  import('@/features/admin/settings/settings-page').then((m) => ({ default: m.SettingsPage })),
);
const AuditPage = lazy(() =>
  import('@/features/admin/audit/audit-page').then((m) => ({ default: m.AuditPage })),
);
const AddressesPage = lazy(() =>
  import('@/features/admin/addresses/addresses-page').then((m) => ({ default: m.AddressesPage })),
);

export const router = createBrowserRouter([
  {
    path: '/login',
    element: (
      <Suspense fallback={<FullScreenLoader />}>
        <LoginPage />
      </Suspense>
    ),
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
          { path: 'settings', element: <SettingsPage /> },
          { path: 'audit', element: <AuditPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
