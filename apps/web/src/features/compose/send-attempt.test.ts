import { describe, expect, it } from 'vitest';
import { ApiError, toApiError } from '@/api/errors';
import { classifySendError } from './send-attempt';

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
  });

  it('全部收件人被拒收（delivery_failed）是明确失败，换新 key', () => {
    expect(classifySendError(new ApiError('d', { code: 'delivery_failed', httpStatus: 422 }))).toBe('rejected');
    expect(classifySendError(new ApiError('d', { code: 'delivery_failed' }))).toBe('rejected');
  });
});
