import { afterEach, describe, expect, it, vi } from 'vitest';
import indexHtml from '../../index.html?raw';
import swSource from '../../public/sw.js?raw';

const ORIGIN = 'https://hpc.test';
const SHELL = '<!doctype html><html><head><script type="module" crossorigin src="/assets/index-AAAA1111.js"></script><link rel="modulepreload" crossorigin href="/assets/vendor-react-BBBB2222.js"><link rel="stylesheet" crossorigin href="/assets/index-CCCC3333.css"></head><body><div id="root"></div></body></html>';
const NEW_SHELL = SHELL.replace('index-AAAA1111', 'index-DDDD4444');

type Listener = (event: unknown) => void;

/** 浏览器 Cache Storage 的最小内存实现 */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  return {
    stores,
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        match: async (key: string) => store.get(key)?.clone(),
        put: async (key: string, response: Response) => void store.set(key, response),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
}

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

/** 在隔离的作用域里执行 public/sw.js 本体，拿到事件监听与路由函数 */
function loadWorker({ network, httpCached = () => true }: { network: (url: string) => Promise<Response>; httpCached?: (url: string) => boolean }) {
  const listeners = new Map<string, Listener>();
  const caches = fakeCaches();
  const fetchMock = vi.fn(async (input: string | { url: string }, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    if (init?.cache === 'only-if-cached') {
      if (!httpCached(url)) throw new TypeError('not cached');
      return new Response('cached asset', { status: 200 });
    }
    return network(url);
  });
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
  };
  const exports = new Function('self', 'caches', 'fetch', `${swSource}\nreturn { isShellNavigation, SHELL_CACHE };`)(
    self,
    caches,
    fetchMock,
  ) as { isShellNavigation: (request: { mode: string; method: string; url: string }, origin: string) => boolean; SHELL_CACHE: string };

  /** 只派发 fetch 事件：返回页面拿到的响应 Promise 与后台任务，不等它们完成 */
  function dispatch(path: string, { mode = 'navigate', method = 'GET' } = {}) {
    let responded: Promise<Response> | null = null;
    const pending: Promise<unknown>[] = [];
    listeners.get('fetch')!({
      request: { mode, method, url: `${ORIGIN}${path}` },
      respondWith: (promise: Promise<Response>) => (responded = promise),
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    return { responded: responded as Promise<Response> | null, pending };
  }
  /** 派发 fetch 事件；返回页面拿到的响应（未接管时为 null）与后台任务 */
  async function navigate(path: string, options: { mode?: string; method?: string } = {}) {
    const { responded, pending } = dispatch(path, options);
    const response = responded ? await responded : null;
    await Promise.all(pending);
    return response;
  }
  async function lifecycle(type: 'install' | 'activate') {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)!({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  }
  const shellText = async () => (await (await caches.open(exports.SHELL_CACHE)).match('/'))?.text();
  return { ...exports, self, caches, fetchMock, dispatch, navigate, lifecycle, shellText };
}

afterEach(() => vi.restoreAllMocks());

describe('isShellNavigation', () => {
  const { isShellNavigation } = loadWorker({ network: async () => html(SHELL) });
  const nav = (path: string, extra: Partial<{ mode: string; method: string; origin: string }> = {}) =>
    isShellNavigation({ mode: extra.mode ?? 'navigate', method: extra.method ?? 'GET', url: `${extra.origin ?? ORIGIN}${path}` }, ORIGIN);

  it.each(['/', '/inbox', '/inbox?unread=1', '/login', '/mail/42', '/api-keys', '/v1-notes', '/admin/users/3/mail', '/profile/'])(
    '前端路由 %s 返回外壳',
    (path) => expect(nav(path)).toBe(true),
  );

  it.each([
    '/api', '/api/auth/me', '/api?x=1', '/v1', '/v1/messages', '/assets/index-AAAA1111.js', '/assets/', '/skill.md',
    '/references/messages.md', '/references/', '/llms.txt', '/cdn-cgi/trace', '/sw.js', '/logo.png', '/favicon.png',
    '/.well-known/security.txt',
  ])('%s 不拦截', (path) => expect(nav(path)).toBe(false));

  it('非导航、非 GET、跨源请求不拦截', () => {
    expect(nav('/inbox', { mode: 'cors' })).toBe(false);
    expect(nav('/inbox', { mode: 'no-cors' })).toBe(false);
    expect(nav('/inbox', { method: 'POST' })).toBe(false);
    expect(nav('/inbox', { origin: 'https://evil.test' })).toBe(false);
  });
});

describe('fetch 事件', () => {
  it('没有缓存时走网络并缓存外壳；之后立即返回缓存，同时后台更新', async () => {
    let shell = SHELL;
    const worker = loadWorker({ network: async () => html(shell) });
    const first = await worker.navigate('/inbox');
    expect(await first!.text()).toBe(SHELL);
    expect(await worker.shellText()).toBe(SHELL);

    shell = NEW_SHELL;
    const second = await worker.navigate('/mail/1');
    expect(await second!.text()).toBe(SHELL);
    // 后台更新已写入新外壳，下一次打开使用新版本
    expect(await worker.shellText()).toBe(NEW_SHELL);
    expect(await (await worker.navigate('/inbox'))!.text()).toBe(NEW_SHELL);
  });

  it('外壳引用的资源不在 HTTP 缓存里时不用旧外壳，改等网络', async () => {
    let shell = SHELL;
    const worker = loadWorker({ network: async () => html(shell), httpCached: (url) => !url.includes('vendor-react') });
    await worker.navigate('/inbox');
    shell = NEW_SHELL;
    expect(await (await worker.navigate('/inbox'))!.text()).toBe(NEW_SHELL);
  });

  it('离线时用缓存的外壳；没有缓存时把网络错误交给浏览器', async () => {
    let online = true;
    const worker = loadWorker({ network: async () => (online ? html(SHELL) : Promise.reject(new TypeError('offline'))) });
    online = false;
    await expect(worker.navigate('/inbox')).rejects.toThrow('offline');
    online = true;
    await worker.navigate('/inbox');
    online = false;
    expect(await (await worker.navigate('/inbox'))!.text()).toBe(SHELL);
  });

  it('只缓存 200、text/html 且是本应用外壳的响应', async () => {
    for (const response of [
      html(SHELL, { status: 404 }),
      new Response(SHELL, { status: 200, headers: { 'content-type': 'text/plain' } }),
      html('<html><body>gateway login</body></html>'),
    ]) {
      const worker = loadWorker({ network: async () => response });
      await worker.navigate('/inbox');
      expect(await worker.shellText()).toBeUndefined();
    }
  });

  it('API、静态资源与 Agent 文档不调用 respondWith', async () => {
    const worker = loadWorker({ network: async () => html(SHELL) });
    expect(await worker.navigate('/skill.md')).toBeNull();
    expect(await worker.navigate('/api/messages', { mode: 'cors' })).toBeNull();
    expect(await worker.navigate('/assets/index-AAAA1111.js', { mode: 'cors' })).toBeNull();
    expect(worker.fetchMock).not.toHaveBeenCalled();
  });

  it('紧跟在上一次导航之后的刷新等待后台更新，拿到新外壳（发版后 chunk-reload 不会刷回旧版本）', async () => {
    let shell = SHELL;
    let release!: () => void;
    const worker = loadWorker({
      network: (url) =>
        url.endsWith('/inbox') && shell === NEW_SHELL
          ? new Promise((resolve) => (release = () => resolve(html(shell))))
          : Promise.resolve(html(shell)),
    });
    await worker.navigate('/inbox');
    shell = NEW_SHELL;
    // 第一次打开：后台更新尚未返回，先拿到旧外壳
    const firstOpen = worker.navigate('/inbox');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    // 旧外壳缺 chunk → 页面立即刷新：这次导航等那次更新完成
    const reload = worker.navigate('/login');
    release();
    expect(await (await reload)!.text()).toBe(NEW_SHELL);
    await firstOpen;
  });

  it('上一次后台更新迟迟不返回时最多等 1.5 秒，随后用缓存的外壳应答（弱网不长时间白屏）', async () => {
    let hang = false;
    const worker = loadWorker({ network: () => (hang ? new Promise<Response>(() => {}) : Promise.resolve(html(SHELL))) });
    await worker.navigate('/inbox');
    hang = true;
    vi.useFakeTimers();
    try {
      // 这次导航先拿到缓存，但它的后台更新一直挂起
      expect(await (await worker.dispatch('/inbox').responded)!.text()).toBe(SHELL);
      let settled = false;
      const next = worker.dispatch('/mail/1').responded!.then((response) => {
        settled = true;
        return response;
      });
      await vi.advanceTimersByTimeAsync(1_400);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(true);
      expect(await (await next).text()).toBe(SHELL);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('外壳识别', () => {
  it('index.html 带有 SW 识别外壳用的挂载点标记', () => {
    // sw.js 只缓存含 <div id="root"> 的 HTML；改挂载点写法时同步修改 isShellResponse
    expect(indexHtml).toContain('<div id="root">');
    expect(swSource).toContain(`includes('<div id="root">')`);
  });
});

describe('生命周期', () => {
  it('安装时预先缓存外壳并立即接管；激活时清理旧版本缓存', async () => {
    const worker = loadWorker({ network: async () => html(SHELL) });
    await worker.caches.open('hpc-shell-v0');
    await worker.caches.open('other-cache');
    await worker.lifecycle('install');
    expect(worker.self.skipWaiting).toHaveBeenCalled();
    expect(await worker.shellText()).toBe(SHELL);
    await worker.lifecycle('activate');
    expect([...worker.caches.stores.keys()].sort()).toEqual(['hpc-shell-v1', 'other-cache']);
    expect(worker.self.clients.claim).toHaveBeenCalled();
  });

  it('安装时离线不影响安装', async () => {
    const worker = loadWorker({ network: async () => Promise.reject(new TypeError('offline')) });
    await expect(worker.lifecycle('install')).resolves.toBeUndefined();
    expect(await worker.shellText()).toBeUndefined();
  });
});
