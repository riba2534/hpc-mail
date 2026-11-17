/** 站内 API 文档：内容取自同源静态 Markdown（public/skill.md 与 public/references/*.md），这里只登记路由与目录标题 */
export interface ApiDoc {
  /** 路由段：入口为空串，参考文档为文件名（不含 .md） */
  slug: string;
  /** 同源原文路径 */
  path: string;
  /** 文件第一个一级标题 */
  title: string;
}

export const ENTRY_DOC: ApiDoc = { slug: '', path: '/skill.md', title: 'HPC Mail' };

const reference = (slug: string, title: string): ApiDoc => ({ slug, path: `/references/${slug}.md`, title });

/**
 * public/references 下的全部参考文档，按阅读顺序排列。
 * 与目录或标题不一致时 docs-manifest.test.ts 失败：新增、删除、改名文档后同步这里。
 */
export const REFERENCE_DOCS: readonly ApiDoc[] = [
  reference('mail', '邮件、验证码与发送'),
  reference('attachments', '附件下载与上传'),
  reference('mailboxes-and-domains', '邮箱、共享与多域名'),
  reference('drafts', '草稿与定时发送'),
  reference('webhooks', 'Webhook v2：事件推送'),
  reference('notifications', '个人通知与邮箱转发'),
  reference('mcp', '远程 MCP'),
  reference('auth-and-http', '鉴权、请求与 API Keys'),
  reference('errors', '错误码与改正方法'),
  reference('administration', '管理员功能'),
];

export const API_DOCS_PATH = '/api-docs';

export function docRoute(doc: ApiDoc): string {
  return doc.slug ? `${API_DOCS_PATH}/${doc.slug}` : API_DOCS_PATH;
}

/** 路由参数对应的文档；没有参数是入口，未登记的返回 undefined */
export function findDoc(param: string | undefined): ApiDoc | undefined {
  if (param === undefined) return ENTRY_DOC;
  return REFERENCE_DOCS.find((doc) => doc.slug === param);
}

/** 同源原文路径对应的文档，如 /references/mail.md */
export function docForPath(pathname: string): ApiDoc | undefined {
  return [ENTRY_DOC, ...REFERENCE_DOCS].find((doc) => doc.path === pathname);
}
