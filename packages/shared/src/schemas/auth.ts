import { z } from 'zod';
import { userMailboxPolicySchema, type UserMailboxPolicy } from './mailbox-policy.js';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  ROLES,
  USERNAME_REGEX,
  USER_STATUSES,
  type Role,
  type UserStatus,
} from '../constants.js';

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(USERNAME_REGEX, '用户名需为 3-32 位小写字母/数字，可含 - 或 _，且以字母或数字开头');

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`)
  .max(PASSWORD_MAX_LENGTH, `密码最多 ${PASSWORD_MAX_LENGTH} 位`);

/** 已设置的密码（登录、改密的旧密码、敏感操作前重新验证）：只校验非空与上限，不套用新密码的长度规则 */
export const currentPasswordSchema = z.string().min(1).max(PASSWORD_MAX_LENGTH);

/** 两步验证的登记与关闭：重新输入当前密码 */
const reauthPasswordRequestSchema = z.object({
  password: z.string().min(1, '请输入当前密码').max(PASSWORD_MAX_LENGTH),
});

export const loginRequestSchema = z.object({
  username: usernameSchema,
  password: currentPasswordSchema,
  /** 已启用 2FA 的账户需附带 6 位 TOTP 或恢复码 */
  totp: z.string().trim().max(32).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ---- 两步验证（2FA / TOTP） ----

export const enableTwoFactorRequestSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, '请输入 6 位验证码'),
});
export type EnableTwoFactorRequest = z.infer<typeof enableTwoFactorRequestSchema>;

/** 关闭两步验证：必须重新输入当前密码（只凭 TOTP 码不能关闭） */
export const disableTwoFactorRequestSchema = reauthPasswordRequestSchema;
export type DisableTwoFactorRequest = z.infer<typeof disableTwoFactorRequestSchema>;

/** 开始登记两步验证：必须重新输入当前密码 */
export const setupTwoFactorRequestSchema = reauthPasswordRequestSchema;
export type SetupTwoFactorRequest = z.infer<typeof setupTwoFactorRequestSchema>;

/** 开始登记：返回密钥与 otpauth URI（尚未启用，需 verify） */
export interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
}

/**
 * 启用成功：一次性返回恢复码。开启会递增鉴权版本让其他会话失效，
 * token 是替换当前会话的新令牌，后续请求要改用它。
 */
export interface TwoFactorEnabled {
  recoveryCodes: string[];
  token: string;
}

/** 关闭成功：同样让其他会话失效，token 替换当前会话令牌 */
export interface TwoFactorDisabled {
  success: true;
  token: string;
}

export const registerRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  inviteCode: z.string().trim().min(1).max(64).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const changePasswordRequestSchema = z.object({
  oldPassword: currentPasswordSchema,
  newPassword: passwordSchema,
  /** 改密时一并吊销本人全部 API Key（默认吊销：账号可能已泄露，旧 Key 不应继续有效） */
  revokeApiKeys: z.boolean().default(true),
});
export type ChangePasswordRequest = z.input<typeof changePasswordRequestSchema>;

export interface SessionUser {
  id: number;
  username: string;
  role: Role;
  createdAt: string;
  /** 头像访问 URL（带版本号防缓存）；无头像时为 null，前端回退到用户名首字母 */
  avatarUrl: string | null;
  /** 是否已启用两步验证 */
  twoFactorEnabled: boolean;
}

/** 头像上传：base64 图片 + MIME 类型 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const uploadAvatarRequestSchema = z.object({
  contentType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  /** base64 编码的图片内容（不含 data: 前缀） */
  image: z
    .string()
    .min(1)
    .max(Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 4, '头像图片不能超过 2MB')
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, '头像需为合法 base64'),
});
export type UploadAvatarRequest = z.infer<typeof uploadAvatarRequestSchema>;

export interface LoginResponse {
  token: string;
  user: SessionUser;
}

/** 改密响应：新会话外加本次吊销的 API Key 数（revokeApiKeys=false 时为 0） */
export interface ChangePasswordResponse extends LoginResponse {
  revokedApiKeys: number;
}

// ---- 管理端用户管理 ----

export const searchUsersQuerySchema = z.object({
  q: z.string().trim().toLowerCase().min(1, '请输入用户名搜索').max(32),
  excludeUserId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});
export type SearchUsersQuery = z.infer<typeof searchUsersQuerySchema>;

export interface UserSearchResult {
  id: number;
  username: string;
  /** 只有管理员的用户搜索返回角色；共享与成员候选搜索不返回，避免普通用户枚举管理员 */
  role?: Role;
}

export interface UserSearchResults {
  items: UserSearchResult[];
  hasMore: boolean;
}

export const createUserRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  role: z.enum(ROLES).default('user'),
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    status: z.enum(USER_STATUSES).optional(),
    role: z.enum(ROLES).optional(),
    password: passwordSchema.optional(),
    mailboxPolicy: userMailboxPolicySchema.nullable().optional(),
    expectedMailboxPolicyRevision: z.number().int().min(0).optional(),
  })
  .refine((v) => v.status !== undefined || v.role !== undefined || v.password !== undefined || v.mailboxPolicy !== undefined, {
    message: '至少提供一个待更新字段',
  })
  .refine((v) => v.mailboxPolicy === undefined || v.expectedMailboxPolicyRevision !== undefined, {
    path: ['expectedMailboxPolicyRevision'],
    message: '修改邮箱权限需提供当前配置版本',
  });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export interface AdminUser {
  id: number;
  username: string;
  role: Role;
  status: UserStatus;
  mailboxCount: number;
  /** null=公共配置；非空时替代公共域名与认领额度。管理员始终豁免。 */
  mailboxPolicy: UserMailboxPolicy | null;
  mailboxPolicyRevision: number;
  /** 名下已认领的邮箱地址列表（与 mailboxCount 对应） */
  mailboxes: string[];
  /** 名下 API Key 数（删除用户前确认后果用） */
  apiKeyCount: number;
  createdAt: string;
  lastLoginAt: string | null;
  /** 头像访问 URL（带版本号防缓存）；无头像时为 null */
  avatarUrl: string | null;
}
