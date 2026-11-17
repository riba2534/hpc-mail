import { z } from 'zod';

/** 部署金丝雀请求体（内部运维端点，不进 OpenAPI）：收发域名可选，缺省由服务端按系统域名列表选择 */
export const canaryRequestSchema = z
  .object({
    fromDomain: z.string().trim().toLowerCase().optional(),
    toDomain: z.string().trim().toLowerCase().optional(),
  })
  .strict();
export type CanaryRequest = z.infer<typeof canaryRequestSchema>;
