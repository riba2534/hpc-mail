import { useQuery } from '@tanstack/react-query';
import { ExternalLink, SearchX } from 'lucide-react';
import { type MouseEvent, type ReactNode, useEffect, useMemo } from 'react';
import { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, NETWORK_ERROR_MESSAGE } from '@/api/errors';
import { PageHeader } from '@/components/page-header';
import { QueryErrorState } from '@/components/query-error-state';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { useDocumentTitle } from '@/lib/use-document-title';
import { type ApiDoc, API_DOCS_PATH, docRoute, ENTRY_DOC, findDoc, REFERENCE_DOCS } from './docs-manifest';
import { renderDoc } from './render-doc';

/** 取同源 Markdown 原文。缺失的文档 Worker 返回 404；开发服务器可能回退成 SPA 页面，同样按不存在处理 */
async function fetchDoc(path: string, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(path, { signal, headers: { Accept: 'text/markdown, text/plain;q=0.9' } });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiError(NETWORK_ERROR_MESSAGE, { code: 'network', cause });
  }
  const isHtml = (response.headers.get('content-type') ?? '').includes('text/html');
  if (response.status === 404 || (response.ok && isHtml)) {
    throw new ApiError('文档不存在', { code: 'not_found', httpStatus: 404 });
  }
  if (!response.ok) throw new ApiError(`文档加载失败（HTTP ${response.status}）`, { code: 'malformed', httpStatus: response.status });
  return response.text();
}

const isNotFound = (error: unknown) => error instanceof ApiError && error.notFound;

export function ApiDocsPage() {
  const params = useParams();
  const doc = findDoc(params.doc);
  const query = useQuery({
    queryKey: ['api-docs', doc?.path ?? ''],
    queryFn: ({ signal }) => fetchDoc(doc?.path ?? '', signal),
    enabled: doc !== undefined,
    // 文档随前端一起发布，同一会话内不必反复拉取
    staleTime: 10 * 60_000,
  });
  const rendered = useMemo(() => (doc && query.data !== undefined ? renderDoc(query.data, doc) : null), [doc, query.data]);
  // 入口沿用路由标题「API 文档」；参考文档带上自己的标题
  useDocumentTitle(doc?.slug ? `${doc.title} · API 文档` : null);

  let content: ReactNode;
  if (!doc || isNotFound(query.error)) {
    content = (
      <EmptyState
        icon={SearchX}
        title="文档不存在"
        description="链接里的文档可能已改名或删除。"
        action={
          <Button asChild variant="secondary">
            <Link to={API_DOCS_PATH}>返回文档入口</Link>
          </Button>
        }
      />
    );
  } else if (query.isError) {
    content = <QueryErrorState error={query.error} onRetry={() => void query.refetch()} className="border-0" />;
  } else if (!rendered) {
    content = (
      <div role="status" aria-label="文档加载中" className="flex flex-col gap-3">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  } else {
    content = <DocContent html={rendered.html} />;
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="API 文档"
        description="通过 API Key 调用开放 API（/v1）收发邮件、管理邮箱与域名；同一份说明也提供给 AI Agent。"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {doc && <ExternalButton href={doc.path}>查看原文</ExternalButton>}
            <ExternalButton href="/v1/openapi.json" title="API Key 接口（/v1）的 OpenAPI 规格">
              OpenAPI
            </ExternalButton>
            <ExternalButton href="/api/openapi.json" title="会话接口（/api，JWT 登录）的 OpenAPI 规格">
              会话 OpenAPI
            </ExternalButton>
          </div>
        }
      />
      <DocsNav className="mb-4 flex gap-1 overflow-x-auto pb-1 lg:hidden" itemClassName="shrink-0" />
      <div className="flex items-start gap-5">
        <DocsNav className="sticky top-14 hidden shrink-0 lg:block lg:w-[220px]" itemClassName="block" grouped />
        <article className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-4 py-5 text-sm text-ink md:px-6">
          {content}
        </article>
      </div>
    </div>
  );
}

function ExternalButton({ href, title, children }: { href: string; title?: string; children: ReactNode }) {
  return (
    <Button asChild variant="secondary" size="sm">
      <a href={href} target="_blank" rel="noopener noreferrer" title={title}>
        {children}
        <ExternalLink className="size-3.5" />
      </a>
    </Button>
  );
}

/**
 * 文档目录：宽屏是左侧栏（分组），窄屏收到正文上方横向滚动；两份由断点切换显示。
 * 只用设计系统已有的工具类，文档页不给全站样式表增加体积。
 */
function DocsNav({ className, itemClassName, grouped = false }: { className: string; itemClassName: string; grouped?: boolean }) {
  const item = (doc: ApiDoc) => (
    <NavLink
      key={doc.path}
      to={docRoute(doc)}
      end
      className={({ isActive }) =>
        cn(
          'rounded-md px-3 py-1.5 text-sm transition-colors',
          itemClassName,
          isActive ? 'bg-accent-soft font-medium text-accent' : 'text-ink-secondary hover:bg-surface-hover hover:text-ink',
        )
      }
    >
      {doc.title}
    </NavLink>
  );
  const group = (label: string) => grouped && <p className="px-3 pt-3 pb-1 text-xs font-medium text-ink-tertiary">{label}</p>;
  return (
    <nav aria-label="文档目录" className={className}>
      {group('入口')}
      {item(ENTRY_DOC)}
      {group('参考文档')}
      {REFERENCE_DOCS.map(item)}
    </nav>
  );
}

/** 渲染好的正文；站内文档链接走客户端路由，带锚点时滚动到对应标题 */
function DocContent({ html }: { html: string }) {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    let id = '';
    try {
      id = decodeURIComponent(location.hash.slice(1));
    } catch {
      id = location.hash.slice(1);
    }
    const target = id ? document.getElementById(id) : null;
    if (target) target.scrollIntoView?.();
    else window.scrollTo?.(0, 0);
  }, [html, location.key]);

  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as Element).closest('a[data-doc-route]');
    const href = anchor?.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    navigate(href);
  };

  // 内容已在 renderDoc 中经 DOMPurify 清洗，链接只保留 http/https 与站内路径
  return <div className="break-words leading-relaxed" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
