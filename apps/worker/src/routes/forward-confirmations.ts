import { confirmForwardRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { ok, parseBody } from '../lib/http.js';
import { confirmForward } from '../services/forward-confirm.js';
import type { AppContext } from '../types.js';

/**
 * /api/forward-confirmations：目标邮箱的主人确认接收转发。公开接口，凭确认信里的一次性 token（32 字节随机数，
 * 库里只存哈希）；确认要求 POST，邮件客户端或链接预览预取 GET 页面不会误确认。
 */
const app = new Hono<AppContext>();

app.post('/confirm', async (c) => {
  const req = await parseBody(c, confirmForwardRequestSchema);
  return ok(c, await confirmForward(c.env, req.token));
});

export default app;
