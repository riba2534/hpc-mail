import { transferMailboxRequestSchema } from '@hpc-mail/shared';
import { Hono } from 'hono';
import { clientIp, ok, parseBody, parseId } from '../../lib/http.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { transferMailbox } from '../../services/mailbox.js';
import type { AppContext } from '../../types.js';

const app = new Hono<AppContext>();
app.use('*', requireAuth, requireAdmin);

app.post('/:id/transfer', async (c) => {
  const req = await parseBody(c, transferMailboxRequestSchema);
  return ok(c, await transferMailbox(c.env, c.get('user')!, parseId(c.req.param('id')), req, clientIp(c)));
});

export default app;
