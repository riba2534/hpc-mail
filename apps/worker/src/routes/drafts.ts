import { draftInputSchema, listDraftsQuerySchema, sendDraftRequestSchema, type StoredDraftContent } from '@hpc-mail/shared';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { AppError } from '../lib/errors.js';
import { ok, parseBody, parseId, parseQuery } from '../lib/http.js';
import { apiKeyAuth, keyRestriction, requireAnyScope, requireScope } from '../middleware/api-key-auth.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createDraft, deleteDraft, getDraft, listDrafts, sendDraftNow, updateDraft, type DraftActor, type DraftOwner,
} from '../services/drafts.js';
import type { Sender } from '../services/outbound.js';
import type { AppContext } from '../types.js';
import { assertRequestSize, authorizeSendContent, sendEnvironment } from './send-handler.js';

/** 当前调用方：网页会话（JWT）或 API Key；草稿始终属于它们背后的用户 */
function actorOf(c: Context<AppContext>): DraftActor & { sender: Sender; owner: DraftOwner } {
  const key = c.get('apiKey');
  if (key) {
    const restrictedKeyId = keyRestriction(c) ? key.id : null;
    return { userId: key.userId, restrictedKeyId, via: 'api', apiKeyId: key.id, idempotencyActor: { type: 'api_key', id: key.id },
      sender: { userId: key.userId, role: key.role }, owner: { userId: key.userId, keyId: restrictedKeyId } };
  }
  const user = c.get('user');
  if (!user) throw new AppError('unauthorized', '缺少访问令牌');
  return { userId: user.id, restrictedKeyId: null, via: 'web', apiKeyId: null, idempotencyActor: { type: 'user', id: user.id },
    sender: { userId: user.id, role: user.role }, owner: { userId: user.id } };
}

/** 读草稿：Key 有 mail.read 或 mail.send 之一即可（发信的 Agent 要能读回自己的草稿）；网页会话不限 */
function requireRead(c: Context<AppContext>): void {
  if (c.get('apiKey')) requireAnyScope(c, ['mail.read', 'mail.send']);
}

/** 写与发送：Key 需 mail.send */
function requireWrite(c: Context<AppContext>): void {
  if (c.get('apiKey')) requireScope(c, 'mail.send');
}

/** 草稿内容的授权与直接发信同一口径（authorizeSendContent），在合并出完整内容后调用 */
function contentGuard(c: Context<AppContext>) {
  return (content: Pick<StoredDraftContent, 'from' | 'replyToMessageId' | 'forwardAttachmentsFrom'>) => authorizeSendContent(c, content);
}

/**
 * 服务端草稿与定时发送：/api/drafts（JWT）与 /v1/drafts（API Key）同一套路由与 service。
 * 只能看到、操作自己的草稿（管理员也一样），别人的 id 一律 404；限定了范围的 Key 只能看到它自己创建的草稿。
 */
export function createDraftRoutes(authentication: MiddlewareHandler<AppContext>) {
  const app = new Hono<AppContext>();
  app.use('*', authentication);

  app.get('/', async (c) => {
    requireRead(c);
    return ok(c, await listDrafts(c.env, actorOf(c).owner, parseQuery(c, listDraftsQuerySchema)));
  });

  app.post('/', async (c) => {
    requireWrite(c);
    assertRequestSize(c);
    const input = await parseBody(c, draftInputSchema);
    await authorizeSendContent(c, input);
    const result = await createDraft(c.env, actorOf(c), input, sendEnvironment(c), c.req.header('Idempotency-Key'));
    return ok(c, result.draft, result.replayed ? 200 : 201);
  });

  app.get('/:id', async (c) => {
    requireRead(c);
    return ok(c, await getDraft(c.env, actorOf(c).owner, parseId(c.req.param('id'))));
  });

  app.patch('/:id', async (c) => {
    requireWrite(c);
    assertRequestSize(c);
    const id = parseId(c.req.param('id'));
    const input = await parseBody(c, draftInputSchema);
    return ok(c, await updateDraft(c.env, actorOf(c), id, input, sendEnvironment(c), contentGuard(c)));
  });

  app.delete('/:id', async (c) => {
    requireWrite(c);
    await deleteDraft(c.env, actorOf(c).owner, parseId(c.req.param('id')));
    return ok(c, { success: true as const });
  });

  /**
   * 立即发送：结果与 POST /messages 相同（201 / 422 delivery_failed / 4xx）；已发送的重放原结果。
   * 请求体可省略；人审时带 {expectedVersion} 锁定审阅过的版本
   */
  app.post('/:id/send', async (c) => {
    requireWrite(c);
    const id = parseId(c.req.param('id'));
    const actor = actorOf(c);
    const body = c.req.header('Content-Length') === '0' || c.req.raw.body === null ? {} : await parseBody(c, sendDraftRequestSchema);
    const summary = await sendDraftNow(sendEnvironment(c), actor.sender, id, contentGuard(c), body.expectedVersion, actor.restrictedKeyId);
    return ok(c, summary, 201);
  });

  return app;
}

export const apiDrafts = createDraftRoutes(requireAuth);
export const v1Drafts = createDraftRoutes(apiKeyAuth);
