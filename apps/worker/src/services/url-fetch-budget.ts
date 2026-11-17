import { MAX_URL_ATTACHMENT_BUFFER_BYTES, MAX_URL_ATTACHMENT_FETCHES_PER_MINUTE } from '@hpc-mail/shared';
import { AppError } from '../lib/errors.js';
import type { Env } from '../types.js';
import { counterResult, counterStatement, minuteWindow, type CounterGuard } from './rate-counter.js';

/** URL 附件拉取次数：按用户每分钟一格（count=拉取的 URL 个数），发信、批量的每一项与草稿共用 */
export const URL_FETCH_SCOPE = 'url-fetch';

/**
 * 一个请求里「没有 Content-Length、要先读进内存」的 URL 附件缓冲合计还剩多少字节。
 * 整个请求共用一份（批量发送的各项并发拉取也从同一份里扣），边读边扣，扣完即拒，不随单项结束归还。
 */
export interface UrlBufferBudget {
  remaining: number;
}

export function newUrlBufferBudget(): UrlBufferBudget {
  return { remaining: MAX_URL_ATTACHMENT_BUFFER_BYTES };
}

/** 占用 count 次拉取额度的语句（与同一请求里的其他计数合进一个 batch）；guard 不成立时不写入、结果无行 */
export function urlFetchStatement(env: Env, userId: number, count: number, window: number, guard?: CounterGuard): D1PreparedStatement {
  return counterStatement(env, URL_FETCH_SCOPE, String(userId), window, count, 0, guard);
}

/** 读占用语句的结果：超过每分钟上限时退回本次占用并抛 429 */
export async function settleUrlFetch(env: Env, userId: number, count: number, window: number, result: D1Result | undefined): Promise<void> {
  const used = counterResult(result)?.count ?? count;
  if (used <= MAX_URL_ATTACHMENT_FETCHES_PER_MINUTE) return;
  await counterStatement(env, URL_FETCH_SCOPE, String(userId), window, -count).run()
    .catch((error) => console.error('URL 附件拉取额度退回失败:', error));
  throw new AppError('rate_limited', `每分钟最多拉取 ${MAX_URL_ATTACHMENT_FETCHES_PER_MINUTE} 个 URL 附件，请稍后再试`, {
    fix: '稍后重试，或把文件先用 POST /v1/uploads（网页会话用 /api/uploads）上传后写进 attachmentTokens',
    docs: '/references/attachments.md#url-附件',
  });
}

/**
 * 单独占用拉取额度（草稿保存时在拉取前调用）。guard 是调用方自己的前置条件（如草稿数上限），与计数同一条语句判断：
 * 不成立时什么也不写、返回 false，由调用方拒绝——被拒的请求不占额度，也不用再退回。
 */
export async function reserveUrlFetches(env: Env, userId: number, count: number, guard?: CounterGuard): Promise<boolean> {
  const window = minuteWindow(1);
  const result = await urlFetchStatement(env, userId, count, window, guard).all();
  if (guard && !counterResult(result)) return false;
  await settleUrlFetch(env, userId, count, window, result);
  return true;
}
