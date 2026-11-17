/// <reference types="vite/client" />

/** 构建时注入的构建号（见 vite.config.ts）；测试环境未定义 */
declare const __HPC_BUILD__: string | undefined;
