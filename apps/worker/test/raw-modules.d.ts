// Vite 的 ?raw 导入：把 apps/web/public 下的 Agent 文档与 wrangler 配置作为字符串读入契约测试。
// 只声明 .md/.txt/.toml，源码的 ?raw 导入仍按各测试里的 @ts-expect-error 处理。
declare module '*.md?raw' {
  const content: string;
  export default content;
}
declare module '*.txt?raw' {
  const content: string;
  export default content;
}
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
// Vite 的 import.meta.glob：测试里枚举 apps/web/public 下的文档文件
interface ImportMeta {
  glob(pattern: string, options?: { query?: string; import?: string; eager?: boolean }): Record<string, unknown>;
}
declare module '*/_headers?raw' {
  const content: string;
  export default content;
}
declare module '*.toml?raw' {
  const content: string;
  export default content;
}
