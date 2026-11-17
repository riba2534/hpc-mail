import type { Mailbox, Page } from '@hpc-mail/shared';

/**
 * 测试用：替身 `api.get('/mailboxes', { query })`，模拟全站邮箱分页接口。
 * 列表顺序即服务端的 id 倒序；q 按地址或所有者用户名子串过滤，domain 精确匹配；游标是不透明的偏移量。
 */
export function fakeAdminMailboxesApi(boxes: Pick<Mailbox, 'address' | 'domain' | 'ownerUsername'>[]) {
  return async (path: string, options?: { query?: Record<string, unknown> }): Promise<Page<unknown>> => {
    const query = (options?.query ?? {}) as { all?: number; q?: string; domain?: string; cursor?: string; limit?: number };
    if (path !== '/mailboxes' || query.all !== 1 || !query.limit) throw new Error(`unexpected GET ${path} ${JSON.stringify(query)}`);
    const matched = boxes.filter((box) => (!query.q || box.address.includes(query.q) || (box.ownerUsername ?? '').includes(query.q))
      && (!query.domain || box.domain === query.domain));
    const start = query.cursor ? Number(query.cursor) : 0;
    const end = start + query.limit;
    return { items: matched.slice(start, end), nextCursor: end < matched.length ? String(end) : null };
  };
}

/** 测试用：列表末尾一被观察就算进入视口，自动加载会一页接一页把数据取完 */
export class AlwaysVisibleObserver {
  constructor(private readonly callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.callback([{ isIntersecting: true, target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
