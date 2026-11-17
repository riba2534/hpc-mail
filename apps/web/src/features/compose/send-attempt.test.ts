import { describe, expect, it } from 'vitest';
import { ApiError, toApiError } from '@/api/errors';
import { classifySendError, missingSendSource } from './send-attempt';

describe('classifySendError', () => {
  it('网络、超时、通用冲突与 5xx 结果不确定，保留同一个 key 重试', () => {
    expect(classifySendError(toApiError(new TypeError('Failed to fetch')))).toBe('uncertain');
    expect(classifySendError(new ApiError('t', { code: 'timeout' }))).toBe('uncertain');
    expect(classifySendError(new ApiError('t', { code: 'internal', httpStatus: 408 }))).toBe('uncertain');
    expect(classifySendError(new ApiError('c', { code: 'conflict', httpStatus: 409 }))).toBe('uncertain');
    expect(classifySendError(new ApiError('g', { code: 'internal', httpStatus: 503 }))).toBe('uncertain');
    expect(classifySendError(new Error('boom'))).toBe('uncertain');
  });

  it('处理中与内容不一致的 409 各自独立，不再与 5xx 一起归为「重试同一 key」', () => {
    expect(classifySendError(new ApiError('p', { code: 'send_in_progress', httpStatus: 409 }))).toBe('in_progress');
    expect(classifySendError(new ApiError('m', { code: 'idempotency_mismatch', httpStatus: 409 }))).toBe('key_mismatch');
  });

  it('4xx 业务错误是明确失败', () => {
    expect(classifySendError(new ApiError('v', { code: 'validation_failed', httpStatus: 400 }))).toBe('rejected');
    expect(classifySendError(new ApiError('r', { code: 'rate_limited', httpStatus: 429 }))).toBe('rejected');
    expect(classifySendError(new ApiError('f', { code: 'forbidden', httpStatus: 403 }))).toBe('rejected');
    // 全部收件人被拒收：没有任何人收到，换新 key
    expect(classifySendError(new ApiError('d', { code: 'delivery_failed', httpStatus: 422 }))).toBe('rejected');
  });
});

describe('missingSendSource', () => {
  const gone = (source?: 'reply' | 'forward') =>
    new ApiError('原邮件不可用', { code: 'source_unavailable', httpStatus: 404, details: source ? { source } : undefined });
  const both = { replyToMessageId: 5, forwardAttachmentsFrom: 8 };

  it('按服务端 details.source 归类：同时带回复与转发引用时也能认出是回复线程不可用', () => {
    expect(missingSendSource(gone('reply'), both)).toBe('reply');
    expect(missingSendSource(gone('forward'), both)).toBe('forward');
    expect(missingSendSource(gone('reply'), { replyToMessageId: 5 })).toBe('reply');
  });

  it('旧服务端没有 details.source：按请求里的字段推断，两者都带时归到转发', () => {
    expect(missingSendSource(gone(), both)).toBe('forward');
    expect(missingSendSource(gone(), { replyToMessageId: 5 })).toBe('reply');
    expect(missingSendSource(gone(), { forwardAttachmentsFrom: 8 })).toBe('forward');
    expect(missingSendSource(gone(), {})).toBeNull();
  });

  it('details.source 指向请求里没有的引用时不采信，回退到按字段推断', () => {
    expect(missingSendSource(gone('reply'), { forwardAttachmentsFrom: 8 })).toBe('forward');
    expect(missingSendSource(gone('forward'), {})).toBeNull();
  });

  it('其他错误不归为来源不可用', () => {
    expect(missingSendSource(new ApiError('x', { code: 'not_found', httpStatus: 404 }), both)).toBeNull();
    expect(missingSendSource(new Error('boom'), both)).toBeNull();
  });
});
