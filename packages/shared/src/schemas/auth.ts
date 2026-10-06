import { z } from 'zod';
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

export const loginRequestSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  /** 已启用 2FA 的账户需附带 6 位 TOTP 或恢复码 */
  totp: z.string().trim().max(32).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

// ---- 两步验证（2FA / TOTP） ----

export const enableTwoFactorRequestSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, '请输入 6 位验证码'),
});
export type EnableTwoFactorRequest = z.infer<typeof enableTwoFactorRequestSchema>;

export const disableTwoFactorRequestSchema = z.object({
  /** 当前密码或有效 TOTP 码任一 */
  password: z.string().max(PASSWORD_MAX_LENGTH).optional(),
  code: z.string().trim().max(32).optional(),
});
export type DisableTwoFactorRequest = z.infer<typeof disableTwoFactorRequestSchema>;

/** 开始登记：返回密钥与 otpauth URI（尚未启用，需 verify） */
export interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
}

/** 启用成功：一次性返回恢复码 */
export interface TwoFactorEnabled {
  recoveryCodes: string[];
}

export const registerRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  inviteCode: z.string().trim().min(1).max(64).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const changePasswordRequestSchema = z.object({
  oldPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

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
  role: Role;
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
  })
  .refine((v) => v.status !== undefined || v.role !== undefined || v.password !== undefined, {
    message: '至少提供一个待更新字段',
  });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export interface AdminUser {
  id: number;
  username: string;
  role: Role;
  status: UserStatus;
  mailboxCount: number;
  /** 名下已认领的邮箱地址列表（与 mailboxCount 对应） */
  mailboxes: string[];
  /** 名下 API Key 数（删除用户前确认后果用） */
  apiKeyCount: number;
  createdAt: string;
  lastLoginAt: string | null;
  /** 头像访问 URL（带版本号防缓存）；无头像时为 null */
  avatarUrl: string | null;
}
