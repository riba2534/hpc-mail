import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  server: {
    proxy: {
      // 只代理 /api、/v1 本身及其子路径；/api-keys 等前端路由刷新时必须交给 Vite 返回 SPA
      '^/api(?:[/?]|$)': 'http://127.0.0.1:8787',
      '^/v1(?:[/?]|$)': 'http://127.0.0.1:8787',
    },
  },
  build: {
    sourcemap: false,
    outDir: 'dist',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              // 框架层几乎不随业务发版变化：单独成块，发版后浏览器缓存继续命中
              name: 'vendor-react',
              test: /node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(?:react|react-dom|scheduler|react-router|react-router-dom|@tanstack[\\/]query-core|@tanstack[\\/]react-query)[\\/]/,
              priority: 30,
            },
            {
              // 图标合成块，避免每个图标一个几百字节的 chunk；入口静态用到的单独一块，
              // 登录页不必下载其余页面的图标
              name: 'icons',
              test: /node_modules[\\/].*lucide-react[\\/]/,
              tags: ['$initial'],
              priority: 21,
              includeDependenciesRecursively: false,
            },
            {
              name: 'icons-lazy',
              test: /node_modules[\\/].*lucide-react[\\/]/,
              priority: 20,
              includeDependenciesRecursively: false,
            },
          ],
        },
      },
    },
  },
});
