import { useQueryClient } from '@tanstack/react-query';
import {
  AtSign,
  ChevronDown,
  Keyboard,
  Globe,
  Inbox,
  KeyRound,
  Lock,
  LogOut,
  Mails,
  Menu,
  Share2,
  PenLine,
  Send,
  ScrollText,
  Settings,
  Trash2,
  Star,
  Ticket,
  User,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { type MouseEvent, Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useMatches, useNavigate } from 'react-router-dom';
import { clearAuthToken } from '@/lib/auth-token';
import { authApi } from '@/api/resources';
import logoUrl from '@/assets/logo.webp';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Avatar } from '@/components/ui/avatar';
import { GithubIconLink } from '@/components/ui/github-link';
import { IconButton } from '@/components/ui/icon-button';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { useUnreadCount } from '@/features/inbox/use-unread-count';
import { cn } from '@/lib/cn';
import { usePublicConfig } from '@/lib/use-config';
import { formatDocumentTitle, useTitleOverride } from '@/lib/use-document-title';
import { useKeyboardShortcuts } from '@/lib/use-keyboard-shortcuts';
import { useCurrentUser } from '@/lib/use-session';
import { lazyWithReload } from './chunk-reload';
import { PageLoader } from './page-loader';
import { preloadable } from './route-modules';
import type { RouteHandle } from './router';
import { ShortcutsHelpDialog } from './shortcuts-help-dialog';

const ChangePasswordDialog = lazyWithReload(
  preloadable(() => import('./change-password-dialog')),
  (m) => m.ChangePasswordDialog,
);

interface NavEntry {
  to: string;
  label: string;
  icon: LucideIcon;
}

const PRIMARY_NAV: NavEntry[] = [
  { to: '/inbox', label: '收件箱', icon: Inbox },
  { to: '/starred', label: '星标', icon: Star },
  { to: '/sent', label: '已发送', icon: Send },
  { to: '/mailboxes', label: '我的邮箱', icon: AtSign },
  { to: '/trash', label: '回收站', icon: Trash2 },
  { to: '/api-keys', label: 'API Keys', icon: KeyRound },
  { to: '/profile', label: '个人设置', icon: User },
];

const ADMIN_NAV: NavEntry[] = [
  { to: '/admin/users', label: '用户', icon: Users },
  { to: '/admin/domains', label: '域名', icon: Globe },
  { to: '/admin/addresses', label: '全站地址', icon: AtSign },
  { to: '/admin/shared-mailboxes', label: '共享邮箱', icon: Share2 },
  { to: '/admin/mail', label: '全站邮件', icon: Mails },
  { to: '/admin/invites', label: '邀请码', icon: Ticket },
  { to: '/admin/audit', label: '操作审计', icon: ScrollText },
  { to: '/admin/settings', label: '系统设置', icon: Settings },
];

const MOBILE_NAV: NavEntry[] = [
  { to: '/inbox', label: '收件箱', icon: Inbox },
  { to: '/starred', label: '星标', icon: Star },
  { to: '/compose', label: '写邮件', icon: PenLine },
  { to: '/mailboxes', label: '邮箱', icon: AtSign },
];

function formatBadge(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** 邮件详情与写信页在移动端全屏：不显示底部导航 */
export function hidesBottomNav(pathname: string): boolean {
  return /^\/mail\/[^/]+\/?$/.test(pathname) || /^\/compose\/?$/.test(pathname);
}

/** 标签页标题：页面覆盖（如邮件主题）优先，其次路由默认标题；带未读数前缀 */
function useShellDocumentTitle(siteTitle: string, unreadCount: number) {
  const matches = useMatches();
  const override = useTitleOverride();
  const routeTitle =
    [...matches].reverse().map((match) => (match.handle as RouteHandle | undefined)?.title).find(Boolean) ?? null;
  const pageTitle = override ?? routeTitle;

  useEffect(() => {
    document.title = formatDocumentTitle(pageTitle, siteTitle, unreadCount);
  }, [pageTitle, siteTitle, unreadCount]);

  // 退出登录等卸载外壳时不留下旧的未读数
  useEffect(() => () => void (document.title = siteTitle), [siteTitle]);
}

const MAIN_ID = 'main-content';

function SkipLink() {
  const focusMain = (event: MouseEvent<HTMLAnchorElement>) => {
    const main = document.getElementById(MAIN_ID);
    if (!main) return;
    // 不改 URL 哈希，直接把焦点移到主内容（focus 会把它滚入视口）
    event.preventDefault();
    main.focus();
  };
  return (
    <a
      href={`#${MAIN_ID}`}
      onClick={focusMain}
      className="sr-only rounded-md bg-accent px-3 py-2 text-sm font-medium text-on-accent focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[60] focus:outline-none focus:ring-2 focus:ring-focus focus:ring-offset-2"
    >
      跳到主内容
    </a>
  );
}

function ComposeButton({ full, onNavigate }: { full: boolean; onNavigate?: () => void }) {
  return (
    <NavLink
      to="/compose"
      onClick={onNavigate}
      className={cn(
        'mb-1 flex h-11 items-center gap-3 rounded-full bg-accent-soft px-4 font-semibold text-accent transition-colors hover:bg-accent hover:text-on-accent',
        full ? 'justify-start' : 'justify-center lg:justify-start',
      )}
    >
      <PenLine className="size-[18px] shrink-0" />
      <span className={full ? 'inline' : 'hidden lg:inline'}>写邮件</span>
    </NavLink>
  );
}

function SideLink({
  entry,
  full,
  badge,
  onNavigate,
}: {
  entry: NavEntry;
  full: boolean;
  badge?: number;
  onNavigate?: () => void;
}) {
  const Icon = entry.icon;
  const showCount = badge !== undefined && badge > 0;
  return (
    <NavLink
      to={entry.to}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'flex h-10 items-center gap-3 rounded-full px-3 text-sm font-medium transition-colors',
          full ? 'justify-start' : 'justify-center lg:justify-start',
          isActive ? 'bg-accent-soft text-accent' : 'text-ink-secondary hover:bg-surface-hover hover:text-ink',
        )
      }
    >
      <span className="relative flex shrink-0">
        <Icon className="size-[18px]" />
        {showCount && (
          <span
            aria-hidden
            className={cn('absolute -right-1.5 -top-1 size-2 rounded-full bg-accent', full ? 'hidden' : 'lg:hidden')}
          />
        )}
      </span>
      <span className={cn('flex-1 truncate', full ? 'inline' : 'hidden lg:inline')}>{entry.label}</span>
      {showCount && (
        <span
          className={cn(
            'ml-auto text-xs font-semibold tabular-nums text-accent',
            full ? 'inline' : 'hidden lg:inline',
          )}
        >
          {formatBadge(badge)}
        </span>
      )}
    </NavLink>
  );
}

function NavSections({
  isAdmin,
  full,
  unreadCount,
  onNavigate,
}: {
  isAdmin: boolean;
  full: boolean;
  unreadCount: number;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-col gap-1 p-2">
      <ComposeButton full={full} onNavigate={onNavigate} />
      {PRIMARY_NAV.map((entry) => (
        <SideLink
          key={entry.to}
          entry={entry}
          full={full}
          badge={entry.to === '/inbox' ? unreadCount : undefined}
          onNavigate={onNavigate}
        />
      ))}
      {isAdmin && (
        <>
          <p className={cn('px-3 pb-1 pt-4 text-xs font-semibold text-ink-tertiary', full ? 'block' : 'hidden lg:block')}>
            管理
          </p>
          {ADMIN_NAV.map((entry) => (
            <SideLink key={entry.to} entry={entry} full={full} onNavigate={onNavigate} />
          ))}
        </>
      )}
    </nav>
  );
}

function UserMenu({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [passwordOpen, setPasswordOpen] = useState(false);
  // 首次打开才加载对话框 chunk；之后保持挂载，关闭动画与原先一致
  const [passwordMounted, setPasswordMounted] = useState(false);

  const handleLogout = async () => {
    try {
      await authApi.logout();
    } catch {
      // 忽略：本地清理照常进行
    }
    clearAuthToken();
    queryClient.clear();
    navigate('/login', { replace: true });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md py-1 pl-1 pr-2 text-sm text-ink transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <Avatar avatarUrl={user.avatarUrl} name={user.username} className="size-7 text-xs" />
            <span className="hidden max-w-32 truncate font-medium sm:inline">{user.username}</span>
            <ChevronDown className="size-4 text-ink-tertiary" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <div className="flex items-center gap-2.5 px-2.5 py-1.5">
            <Avatar avatarUrl={user.avatarUrl} name={user.username} className="size-8 text-xs" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{user.username}</p>
              <p className="text-xs text-ink-tertiary">{user.role === 'admin' ? '管理员' : '普通用户'}</p>
            </div>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => navigate('/profile')}>
            <User className="size-4 text-ink-tertiary" />
            个人设置
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              setPasswordMounted(true);
              setPasswordOpen(true);
            }}
          >
            <Lock className="size-4 text-ink-tertiary" />
            修改密码
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onShowShortcuts}>
            <Keyboard className="size-4 text-ink-tertiary" />
            键盘快捷键
            <kbd className="ml-auto font-sans text-xs text-ink-tertiary">?</kbd>
          </DropdownMenuItem>
          <DropdownMenuItem tone="danger" onSelect={handleLogout}>
            <LogOut className="size-4" />
            退出登录
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {passwordMounted && <ChangePasswordDialog open={passwordOpen} onOpenChange={setPasswordOpen} />}
    </>
  );
}

export function AppShell() {
  const user = useCurrentUser();
  const { data: config } = usePublicConfig();
  const { data: unread } = useUnreadCount();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const isAdmin = user.role === 'admin';
  const siteTitle = config?.siteTitle ?? 'HPC Mail';
  const unreadCount = unread?.unread ?? 0;
  const bottomNavHidden = hidesBottomNav(pathname);
  useKeyboardShortcuts({ onHelp: () => setShortcutsOpen(true) });
  useShellDocumentTitle(siteTitle, unreadCount);

  return (
    <div className="flex min-h-dvh flex-col bg-canvas md:flex-row">
      <SkipLink />
      <aside className="sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-line bg-surface md:flex md:w-16 lg:w-[220px]">
        <div className="flex h-14 items-center border-b border-line px-4 lg:px-5">
          <img src={logoUrl} alt="" className="size-7 shrink-0 rounded-md" />
          <span className="ml-2 hidden truncate text-sm font-semibold text-ink lg:inline">{siteTitle}</span>
        </div>
        <div className="flex-1 overflow-y-auto">
          <NavSections isAdmin={isAdmin} full={false} unreadCount={unreadCount} />
        </div>
        <div className="border-t border-line p-2">
          <NavLink
            to="/profile"
            className={({ isActive }) =>
              cn(
                'flex h-10 items-center gap-3 rounded-full px-3 text-sm font-medium transition-colors',
                'justify-center lg:justify-start',
                isActive ? 'bg-accent-soft text-accent' : 'text-ink-secondary hover:bg-surface-hover hover:text-ink',
              )
            }
          >
            <Avatar avatarUrl={user.avatarUrl} name={user.username} className="size-7 text-xs" />
            <span className="hidden truncate lg:inline">{user.username}</span>
          </NavLink>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface px-4 md:px-6">
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              <IconButton aria-label="打开菜单" className="md:hidden">
                <Menu className="size-5" />
              </IconButton>
            </SheetTrigger>
            <SheetContent side="left" title={siteTitle}>
              <NavSections isAdmin={isAdmin} full unreadCount={unreadCount} onNavigate={() => setMenuOpen(false)} />
            </SheetContent>
          </Sheet>
          <img src={logoUrl} alt="" className="size-7 shrink-0 rounded-md md:hidden" />
          <span className="truncate text-sm font-semibold text-ink md:hidden">{siteTitle}</span>
          <div className="ml-auto flex items-center gap-1">
            <GithubIconLink />
            <UserMenu onShowShortcuts={() => setShortcutsOpen(true)} />
          </div>
        </header>

        <main
          id={MAIN_ID}
          tabIndex={-1}
          className={cn(
            'flex-1 px-4 pt-4 focus:outline-none md:px-6 md:pb-8',
            bottomNavHidden
              ? 'pb-[calc(1rem+env(safe-area-inset-bottom))]'
              : 'pb-[calc(6rem+env(safe-area-inset-bottom))]',
          )}
        >
          {config?.require2fa && !user.twoFactorEnabled ? (
            // 后端此时会对除 2FA 绑定以外的接口返回 totp_setup_required(403)，
            // 继续渲染常规页面只会满屏报错——直接换成阻塞式引导
            <div className="mx-auto mb-4 max-w-4xl rounded-lg border border-caution/40 bg-caution-soft/40 px-4 py-4 text-sm">
              <p className="font-medium text-ink">本站要求所有账户开启两步验证</p>
              <p className="mt-1 text-ink-secondary">
                完成绑定后才能继续使用邮箱功能。绑定入口在「个人设置 - 安全」。
              </p>
              <NavLink
                to="/profile"
                className="mt-3 inline-block rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover"
              >
                去绑定两步验证
              </NavLink>
            </div>
          ) : null}
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <nav
        aria-label="主导航"
        // 仅在可见时带标记：Toast 等路由外的层据此在小屏避让底部导航
        data-bottom-nav={bottomNavHidden ? undefined : ''}
        className={cn(
          'fixed inset-x-0 bottom-0 z-30 grid-cols-4 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden',
          bottomNavHidden ? 'hidden' : 'grid',
        )}
      >
        {MOBILE_NAV.map((entry) => {
          const Icon = entry.icon;
          const showCount = entry.to === '/inbox' && unreadCount > 0;
          return (
            <NavLink
              key={entry.to}
              to={entry.to}
              className={({ isActive }) =>
                cn(
                  'flex h-16 flex-col items-center justify-center gap-1 text-xs font-medium transition-colors',
                  isActive ? 'text-accent' : 'text-ink-tertiary',
                )
              }
            >
              <span className="relative flex">
                <Icon className="size-5" />
                {showCount && (
                  <span className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-on-accent">
                    {formatBadge(unreadCount)}
                  </span>
                )}
              </span>
              {entry.label}
            </NavLink>
          );
        })}
      </nav>
      <ShortcutsHelpDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}
