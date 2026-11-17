import { Hono } from 'hono';
import { AppError } from '../../../lib/errors.js';
import { apiKeyAuth } from '../../../middleware/api-key-auth.js';
import type { AppContext } from '../../../types.js';
import adminClaude from './claude.js';
import adminDirectory from './directory.js';
import adminMailboxes from './mailboxes.js';

/**
 * /v1/admin：管理员 Key 的运维接口（管理员账户 + admin scope，即 Key 的有效角色为 admin）。
 * 写操作复用 /api/admin 的批量服务（同样的事务、审计与逐项结果）：审计操作人为 Key 所属的管理员用户名，
 * detail 末尾带「批量请求 <请求 id>（API Key #id）」，与网页会话的批量操作同一写法。
 */
const app = new Hono<AppContext>();
app.use('*', apiKeyAuth);
app.use('*', async (c, next) => {
  if (c.get('apiKey')!.role !== 'admin') {
    throw new AppError('forbidden', '需要管理员 Key', {
      fix: '用管理员账户创建 Key 并勾选 admin scope（「管理员能力」）；GET /v1/me 的 key.effectiveRole 为 admin 时才能调用 /v1/admin',
      docs: '/references/administration.md#管理员-key-运维接口',
    });
  }
  await next();
});

app.route('/mailboxes', adminMailboxes);
app.route('/claude', adminClaude);
app.route('/', adminDirectory);

// 未匹配的 /v1/admin 路径到此为止，统一 404
app.all('*', () => {
  throw new AppError('not_found', '接口不存在');
});

export default app;
