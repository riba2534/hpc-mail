import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/app/app';
import { bootPrefetch } from '@/app/boot-prefetch';
import { installChunkReloadHandler } from '@/app/chunk-reload';
import '@/styles/index.css';

document.documentElement.style.colorScheme = 'light';

installChunkReloadHandler();
// 在 React 首次渲染前发起首屏数据与 chunk 请求
bootPrefetch();

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
