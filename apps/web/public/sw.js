/*
 * HPC Mail Service Worker：只缓存应用外壳（index.html），让再次打开不必等 HTML 往返。
 *
 * - 只接管同源、GET 的页面导航；/api、/v1、/assets/、Agent 文档、/cdn-cgi/ 与任何带扩展名的文件路径一律不拦截。
 * - 策略 stale-while-revalidate：有缓存的外壳立即返回，同时后台取网络版本更新缓存；没有缓存时走网络。
 *   只缓存 200、text/html 且确实是本应用外壳的响应。绝不缓存 API 响应或任何用户数据。
 * - 缓存的外壳所引用的 /assets/ 文件必须都还在浏览器 HTTP 缓存里才使用它，否则改走网络：
 *   发版后旧文件已从服务器删除，HTTP 缓存又被清掉时，旧外壳只会得到一张白屏。
 *   旧外壳能启动时，之后缺失的 chunk 由页面的 chunk-reload 自动刷新一次换到新版本；
 *   刷新紧跟在上一次导航之后时，先等那次后台更新写入新外壳，避免刷新回同一个旧版本；
 *   最多等 PREVIOUS_UPDATE_WAIT_MS，弱网下上一次请求迟迟不返回时不让这次导航一直白屏。
 * - 修改本文件的缓存逻辑时同步递增 SHELL_CACHE 的版本号，activate 时清理旧版本缓存。
 *
 * 紧急关闭：把本文件整体替换为下面的内容并部署（/sw.js 为 no-cache，浏览器下次导航即取到新版本），
 * 已安装的 Worker 会清空缓存、注销自己并刷新受控页面，之后页面与没有 Service Worker 时完全一致：
 *
 *   self.addEventListener('install', () => self.skipWaiting());
 *   self.addEventListener('activate', (event) => {
 *     event.waitUntil((async () => {
 *       for (const key of await caches.keys()) await caches.delete(key);
 *       await self.registration.unregister();
 *       for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
 *     })());
 *   });
 */

const SHELL_CACHE = 'hpc-shell-v1';
const SHELL_CACHE_PREFIX = 'hpc-shell-';
const SHELL_KEY = '/';
const BYPASS_EXACT = ['/api', '/v1', '/skill.md', '/llms.txt', '/sw.js'];
const BYPASS_PREFIXES = ['/api/', '/v1/', '/assets/', '/references/', '/cdn-cgi/', '/.well-known/'];
/** 导航等待上一次后台更新的上限：超时就按现有缓存或本次网络请求应答 */
const PREVIOUS_UPDATE_WAIT_MS = 1_500;

/** 是否由本 Worker 返回应用外壳：同源 GET 导航，且路径是前端路由 */
function isShellNavigation(request, origin) {
  if (request.mode !== 'navigate' || request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== origin) return false;
  const path = url.pathname;
  if (BYPASS_EXACT.includes(path) || BYPASS_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  // 带扩展名的是静态文件（/logo.png 等），前端路由不含扩展名
  return !/\.[^/]*$/.test(path);
}

async function isShellResponse(response) {
  // 200 已排除 opaque / opaqueredirect；经过重定向的响应不能用来应答导航
  if (response.status !== 200 || response.redirected) return false;
  if (!(response.headers.get('content-type') || '').includes('text/html')) return false;
  // 只认本应用的外壳，不把网关错误页、登录拦截页之类的 HTML 当外壳缓存
  return (await response.clone().text()).includes('<div id="root">');
}

async function storeShell(response) {
  if (!(await isShellResponse(response))) return;
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(SHELL_KEY, response);
}

/** 外壳引用的 /assets/ 文件是否都已在 HTTP 缓存里（只查本地缓存，不发网络请求） */
async function shellAssetsCached(shell) {
  const html = await shell.clone().text();
  const urls = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((match) => match[1]);
  if (urls.length === 0) return false;
  const cached = await Promise.all(
    urls.map((url) =>
      fetch(url, { cache: 'only-if-cached', mode: 'same-origin' }).then(
        (response) => {
          response.body?.cancel().catch(() => {});
          return response.ok;
        },
        () => false,
      ),
    ),
  );
  return cached.every(Boolean);
}

async function cachedShell() {
  const cache = await caches.open(SHELL_CACHE);
  const shell = await cache.match(SHELL_KEY, { ignoreVary: true });
  if (!shell) return null;
  return (await shellAssetsCached(shell)) ? shell : null;
}

/** 进行中的后台更新：紧接着的下一次导航（如发版后 chunk-reload 的刷新）等它写入新外壳 */
let pendingUpdate = null;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  // 预先缓存外壳，下一次打开即可命中；失败（如离线）不影响安装
  event.waitUntil(fetch(SHELL_KEY, { cache: 'no-cache' }).then(storeShell).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE).map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  if (!isShellNavigation(event.request, self.location.origin)) return;
  const previousUpdate = pendingUpdate;
  const network = fetch(event.request);
  // 先于页面消费响应体复制一份：这个回调注册在前，网络响应到达时先执行
  const update = network.then((response) => storeShell(response.clone())).catch(() => {});
  pendingUpdate = update;
  update.then(() => {
    if (pendingUpdate === update) pendingUpdate = null;
  });
  event.waitUntil(update);
  event.respondWith(
    (async () => {
      if (previousUpdate) {
        await Promise.race([previousUpdate, new Promise((resolve) => setTimeout(resolve, PREVIOUS_UPDATE_WAIT_MS))]);
      }
      return (await cachedShell().catch(() => null)) || network;
    })(),
  );
});
