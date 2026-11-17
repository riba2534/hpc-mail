import { MutationCache, QueryClient } from '@tanstack/react-query';
import { ApiError, toApiError } from '@/api/errors';
import { toast } from '@/components/ui/toast';

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: {
      /** 失败提示的标题（如「删除失败」），服务端原因作为说明；不填时以服务端原因作标题 */
      errorTitle?: string;
      /** 页面已就地展示错误时设为 false，不再弹提示 */
      errorToast?: false;
    };
  }
}

export const queryClient = new QueryClient({
  // 写操作失败的统一提示：保留服务端给出的原因（限流、权限变化等），附请求 ID 便于反馈排障。
  // 自带 onError 的写操作视为自行提示（表单内联错误等），除非另外声明了 meta.errorTitle（onError 只做回滚之类）。
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      const title = mutation.meta?.errorTitle;
      if (mutation.meta?.errorToast === false || (!title && mutation.options.onError)) return;
      const { message, requestId } = toApiError(error);
      toast({ title: title ?? message, description: title && message, requestId, variant: 'error' });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus < 500) {
          return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});
