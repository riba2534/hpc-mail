import type { ApiScope, Role, UserStatus } from '@hpc-mail/shared';

/** Worker 运行时绑定与变量（对应 wrangler.toml） */
export interface Env {
  db: D1Database;
  kv: KVNamespace;
  r2: R2Bucket;
  assets: Fetcher;
  /** send_email binding：Cloudflare 原生发信（仅已验证 destination） */
  email: SendEmail;
  /** Canonical web origin for links in relayed mail. */
  site_origin?: string;
  build_sha?: string;
  /** secret：JWT 签名密钥 */
  jwt_secret: string;
  /** Optional OIDC login: explicitly bind one issuer subject to an existing user. */
  oidc_issuer?: string;
  oidc_client_id?: string;
  oidc_client_secret?: string;
  oidc_subject?: string;
  oidc_user_id?: string;
  /** secret：托管域名使用的站长 Cloudflare API Token；与 cf_account_id 都配置时才启用托管域名 */
  cf_api_token?: string;
  /** secret：站长 Cloudflare 账户 ID（资源 ID 不入库，由 CI 注入） */
  cf_account_id?: string;
  /** 托管域名 catch-all 投递的目标脚本名，须与 wrangler.toml 的 name 一致 */
  worker_name?: string;
}

/** 内部 API 鉴权后的用户上下文 */
export interface AuthUser {
  id: number;
  username: string;
  role: Role;
  status: UserStatus;
  createdAt: Date;
  avatarKey: string | null;
  twoFactorEnabled: boolean;
}

/** /v1 API Key 鉴权后的上下文 */
export interface ApiKeyContext {
  id: number;
  userId: number;
  role: Role;
  scopes: ApiScope[];
}

export interface AppVariables {
  requestId: string;
  user?: AuthUser;
  sessionId?: string;
  apiKey?: ApiKeyContext;
  apiClientIp?: string;
  apiStartedAt?: number;
}

/** Hono 泛型上下文 */
export interface AppContext {
  Bindings: Env;
  Variables: AppVariables;
}

/** waitUntil 的最小结构类型（兼容 CF 与 Hono 的 ExecutionContext） */
export interface ExecCtx {
  waitUntil(promise: Promise<unknown>): void;
}
