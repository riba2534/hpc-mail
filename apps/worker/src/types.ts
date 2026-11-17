import type { ApiScope, Role, UserStatus } from '@hpc-mail/shared';
import type { RateLimitBindingName } from './services/rate-limit.js';

/**
 * Worker 运行时绑定与变量（对应 wrangler.toml）。
 * Rate Limiting binding（rl_*）可缺省：缺失时 services/rate-limit.ts 退回进程内计数。
 */
export interface Env extends Partial<Record<RateLimitBindingName, RateLimit>> {
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
  /** secret：托管域名使用的站长 Cloudflare API Token；与 cf_account_id 都配置时才启用托管域名 */
  cf_api_token?: string;
  /** secret：站长 Cloudflare 账户 ID（资源 ID 不入库，由 CI 注入） */
  cf_account_id?: string;
  /** 托管域名 catch-all 投递的目标脚本名，须与 wrangler.toml 的 name 一致 */
  worker_name?: string;
  /**
   * 投递回执 Queue 名：设置了 GitHub Variable DELIVERY_EVENTS_QUEUE 时 CI 注入（同时注入 Queue consumer）；
   * 未设置即未启用投递回执
   */
  delivery_events_queue?: string;
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
  /** 所属用户的用户名（鉴权时连表读出），供写操作审计 */
  username: string;
  /** 执行角色：所属用户是管理员且 Key 带 admin scope 时为 admin，否则 user */
  role: Role;
  scopes: ApiScope[];
  /** 限定的邮箱认领行 id 与域名；两者都为空表示不限（见 middleware/api-key-auth.ts 的 keyRestriction） */
  allowedMailboxIds: number[];
  allowedDomains: string[];
}

export interface AppVariables {
  requestId: string;
  user?: AuthUser;
  sessionId?: string;
  /** 会话令牌声明的用户鉴权版本（uepoch），requireAuth 校验通过后与 users.auth_version 相等 */
  authEpoch?: number;
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
