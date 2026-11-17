import { API_SCOPES, type ApiScope } from '@hpc-mail/shared';
import { hashPassword } from '../src/lib/password.js';

/** 测试账户的统一登录密码：创建 API Key 需要重新验证它 */
export const TEST_PASSWORD = 'test-password-0001';
let cachedHash: Promise<string> | undefined;
/** PBKDF2 较慢，同一测试文件只算一次 */
export const testPasswordHash = (): Promise<string> => (cachedHash ??= hashPassword(TEST_PASSWORD));

/** 普通用户能授予的全部 scope（admin 只有管理员能授予） */
export const USER_SCOPES: ApiScope[] = API_SCOPES.filter((scope) => scope !== 'admin');

/** 直接给已有 Key 加上 admin scope（模拟迁移 0022 之后的存量管理员 Key，不经创建接口） */
export async function grantLegacyAdminScope(env: { db: D1Database }, keyId: number): Promise<void> {
  await env.db.prepare(`UPDATE api_keys SET scopes = json_insert(scopes, '$[#]', 'admin')
    WHERE id = ? AND NOT EXISTS (SELECT 1 FROM json_each(api_keys.scopes) WHERE value = 'admin')`).bind(keyId).run();
}
