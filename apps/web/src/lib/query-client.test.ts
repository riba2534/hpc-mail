import { MutationObserver, type MutationOptions } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, NETWORK_ERROR_MESSAGE } from '@/api/errors';

const mocks = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: mocks.toast }));
import { queryClient } from './query-client';

const limited = new ApiError('操作过于频繁，请稍后再试', { code: 'rate_limited', httpStatus: 429, requestId: 'req-123' });

async function fail(options: Omit<MutationOptions<unknown, Error, void>, 'mutationFn'>, error: unknown = limited) {
  const observer = new MutationObserver(queryClient, { ...options, mutationFn: () => Promise.reject(error) });
  await observer.mutate().catch(() => {});
}

beforeEach(() => mocks.toast.mockClear());

describe('写操作失败的统一提示', () => {
  it('保留服务端原因并附请求 ID；meta.errorTitle 作标题、原因作说明', async () => {
    await fail({ meta: { errorTitle: '删除失败' } });
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith({
      title: '删除失败',
      description: '操作过于频繁，请稍后再试',
      requestId: 'req-123',
      variant: 'error',
    });
  });

  it('没有定制标题时直接以服务端原因作标题；网络中断给出可读原因', async () => {
    await fail({});
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: '操作过于频繁，请稍后再试', requestId: 'req-123' }));
    await fail({}, new TypeError('Failed to fetch'));
    expect(mocks.toast).toHaveBeenLastCalledWith(expect.objectContaining({ title: NETWORK_ERROR_MESSAGE, requestId: undefined }));
  });

  it('自带 onError 或声明就地展示错误的写操作不重复弹提示', async () => {
    const onError = vi.fn();
    await fail({ onError });
    expect(onError).toHaveBeenCalledOnce();
    await fail({ meta: { errorToast: false } });
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('onError 只做回滚时可另外声明 meta.errorTitle，由这里提示一次', async () => {
    const rollback = vi.fn();
    await fail({ onError: rollback, meta: { errorTitle: '星标操作失败' } });
    expect(rollback).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledOnce();
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: '星标操作失败', requestId: 'req-123' }));
  });
});
