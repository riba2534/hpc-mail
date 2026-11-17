import { Hono } from 'hono';
import type { AppContext } from '../../../types.js';

/** /v1/admin 的claude部分（鉴权由 admin/index.ts 统一完成） */
const app = new Hono<AppContext>();

export default app;
