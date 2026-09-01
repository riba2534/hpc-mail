import { z } from 'zod';
import {
  API_SCOPES,
  DEFAULT_API_RATE_LIMIT,
  MAX_API_RATE_LIMIT,
  type ApiKeyStatus,
  type ApiScope,
} from '../constants.js';

const ipOrCidrSchema = z
  .string()
  .trim()
  .regex(
    /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-fA-F:]+(\/\d{1,3})?$/,
    'IP 或 CIDR 格式非法',
  );

export const createApiKeyRequestSchema = z.object({
  name: z.string().trim().min(1).max(64),
  scopes: z.array(z.enum(API_SCOPES)).min(1),
  rateLimit: z.number().int().min(1).max(MAX_API_RATE_LIMIT).default(DEFAULT_API_RATE_LIMIT),
  allowedIps: z.array(ipOrCidrSchema).max(32).default([]),
  /** ISO 时间；不传则永不过期 */
  expiresAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreateApiKeyRequest = z.infer<typeof createApiKeyRequestSchema>;

export const updateApiKeyRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(64).optional(),
    scopes: z.array(z.enum(API_SCOPES)).min(1).optional(),
    rateLimit: z.number().int().min(1).max(MAX_API_RATE_LIMIT).optional(),
    allowedIps: z.array(ipOrCidrSchema).max(32).optional(),
    status: z.enum(['active', 'disabled']).optional(),
    /** 续期：ISO 时间；显式传 null 表示改为永不过期 */
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: '至少提供一个待更新字段',
  });
export type UpdateApiKeyRequest = z.infer<typeof updateApiKeyRequestSchema>;

export interface ApiKeySummary {
  id: number;
  name: string;
  keyPrefix: string;
  keySuffix: string;
  scopes: ApiScope[];
  rateLimit: number;
  allowedIps: string[];
  status: ApiKeyStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  /** admin 全站视图返回 */
  ownerUsername?: string;
}

export interface CreatedApiKey extends ApiKeySummary {
  /** 完整明文 key，仅创建时返回一次 */
  key: string;
}

export interface ApiRequestLogEntry {
  id: number;
  requestId: string;
  method: string;
  path: string;
  statusCode: number;
  ip: string;
  durationMs: number;
  createdAt: string;
}
