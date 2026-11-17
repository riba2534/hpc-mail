import { draftInputSchema, listDraftsQuerySchema, type StoredDraftContent } from '@hpc-mail/shared';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { AppError } from '../lib/errors.js';
import { ok, parseBody, parseId, parseQuery } from '../lib/http.js';
import { apiKeyAuth, requireScope } from '../middleware/api-key-auth.js';
import { requireAuth } from '../middleware/auth.js';
import {
  createDraft, deleteDraft, getDraft, listDrafts, referencesSource, sendDraftNow, updateDraft, type DraftActor,
} from '../services/drafts.js';
import type { Sender } from '../services/outbound.js';
import type { AppContext } from '../types.js';
import { assertSendBodySize, selfHostsOf } from './send-handler.js';

/** 当前调用方：网页会话（JWT）或 API Key；草稿始终属于它们背后的用户 */
function actorOf(c: Context<AppContext>): DraftActor & { sender: Sender } {
  const key = c.get('apiKey');
  if (key) {
    return { userId: key.userId, via: 'api', apiKeyId: key.id, idempotencyActor: { type: 'api_key', id: key.id },
      sender: { userId: key.userId, role: key.role } };
  }
  const user = c.get('user');
  if (!user) throw new AppError('unauthorized', '缺少访问令牌');
  return { userId: user.id, via: 'web', apiKeyId: null, idempotencyActor: { type: 'user', id: user.id },
    sender: { userId: user.id, role: user.role } };
}

/** 读草稿：Key 有 mail.read 或 mail.send 之一即可（发信的 Agent 要能读回自己的草稿）；网页会话不限 */
function requireRead(c: Context<AppContext>): void {
  const key = c.get('apiKey');
  if (!key || key.scopes.includes('mail.read') || key.scopes.includes('mail.send')) return;
  throw new AppError('forbidden', '需要 API scope: mail.read 或 mail.send', {
    fix: '这把 Key 需要 mail.read 或 mail.send 其中之一：在网页「API Key」页面加上，或换用带其中一个 scope 的 Key（GET /v1/me 可查看当前 scopes）',
    docs: '/references/errors.md#forbidden-scope',
  });
}

/** 写与发送：Key 需 mail.send */
function requireWrite(c: Context<AppContext>): void {
  if (c.get('apiKey')) requireScope(c, 'mail.send');
}

/** 内容引用来源邮件（回复、转发附件）时 Key 另需 mail.read，与直接发信一致 */
function sourceGuard(c: Context<AppContext>) {
  return (content: Pick<StoredDraftContent, 'replyToMessageId' | 'forwardAttachmentsFrom'>) => {
    if (c.get('apiKey') && referencesSource(content)) requireScope(c, 'mail.read');
  };
}

function requestEnv(c: Context<AppContext>) {
  return { origin: new URL(c.req.url).origin, selfHosts: selfHostsOf(c) };
}

/**
 * 服务端草稿与定时发送：/api/drafts（JWT）与 /v1/drafts（API Key）同一套路由与 service。
 * 只能看到、操作自己的草稿（管理员也一样），别人的 id 一律 404。
 */
export function createDraftRoutes(authentication: MiddlewareHandler<AppContext>) {
  const app = new Hono<AppContext>();
  app.use('*', authentication);

  app.get('/', async (c) => {
    requireRead(c);
    return ok(c, await listDrafts(c.env, actorOf(c).userId, parseQuery(c, listDraftsQuerySchema)));
  });

  app.post('/', async (c) => {
    requireWrite(c);
    assertSendBodySize(c);
    const input = await parseBody(c, draftInputSchema);
    sourceGuard(c)({ replyToMessageId: input.replyToMessageId ?? null, forwardAttachmentsFrom: input.forwardAttachmentsFrom ?? null });
    const result = await createDraft(c.env, actorOf(c), input, requestEnv(c), c.req.header('Idempotency-Key'));
    return ok(c, result.draft, result.replayed ? 200 : 201);
  });

  app.get('/:id', async (c) => {
    requireRead(c);
    return ok(c, await getDraft(c.env, actorOf(c).userId, parseId(c.req.param('id'))));
  });

  app.patch('/:id', async (c) => {
    requireWrite(c);
    assertSendBodySize(c);
    const id = parseId(c.req.param('id'));
    const input = await parseBody(c, draftInputSchema);
    return ok(c, await updateDraft(c.env, actorOf(c), id, input, requestEnv(c), sourceGuard(c)));
  });

  app.delete('/:id', async (c) => {
    requireWrite(c);
    await deleteDraft(c.env, actorOf(c).userId, parseId(c.req.param('id')));
    return ok(c, { success: true as const });
  });

  /** 立即发送：结果与 POST /messages 相同（201 / 422 delivery_failed / 4xx）；已发送的重放原结果 */
  app.post('/:id/send', async (c) => {
    requireWrite(c);
    const id = parseId(c.req.param('id'));
    const actor = actorOf(c);
    const summary = await sendDraftNow(c.env, c.executionCtx, actor.sender, id, new URL(c.req.url).origin, sourceGuard(c));
    return ok(c, summary, 201);
  });

  return app;
}

export const apiDrafts = createDraftRoutes(requireAuth);
export const v1Drafts = createDraftRoutes(apiKeyAuth);
