import { Hono } from 'hono';
import { buildSecureHeaders } from '../lib/attachment-security.js';
import { verifyAttachmentSig } from '../lib/crypto.js';
import { AppError } from '../lib/errors.js';
import { parseId } from '../lib/http.js';
import { requireAuth } from '../middleware/auth.js';
import { loadAttachmentById, loadAttachmentForViewer } from '../services/message.js';
import { loadExternalAttachment } from '../services/external-attachment.js';
import { getObject } from '../services/storage.js';
import type { AppContext } from '../types.js';

const app = new Hono<AppContext>();

/** 附件下载：签名 URL（exp+sig，供内嵌 cid 图片）或 JWT + 可见性校验 */
app.get('/:id', async (c) => {
  const id = parseId(c.req.param('id'));
  const exp = Number(c.req.query('exp'));
  const sig = c.req.query('sig');

  let att: Awaited<ReturnType<typeof loadAttachmentById>>;
  if (sig && Number.isInteger(exp)) {
    const valid = await verifyAttachmentSig(c.env.jwt_secret, id, exp, sig);
    if (!valid) throw new AppError('unauthorized', '签名无效或已过期');
    const retained = await loadExternalAttachment(c.env, id);
    if (retained && exp * 1000 <= retained.expiresAt.getTime()) att = { ...retained, id, messageId: 0, contentId: '', disposition: 'attachment' };
    else att = await loadAttachmentById(c.env, id);
  } else {
    await requireAuth(c, async () => {});
    const user = c.get('user')!;
    att = await loadAttachmentForViewer(c.env, { userId: user.id, role: user.role }, id);
  }

  const obj = await getObject(c.env, att.r2Key);
  if (!obj) throw new AppError('not_found', '附件内容不存在');
  const headers = buildSecureHeaders(att.mimeType, att.filename);
  return new Response(obj.body, { status: 200, headers });
});

export default app;
