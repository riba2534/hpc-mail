// Vite 的 ?raw 导入：把 apps/web/public 下的 Agent 文档作为字符串读入契约测试。
// 只声明 .md/.txt，源码的 ?raw 导入仍按各测试里的 @ts-expect-error 处理。
declare module '*.md?raw' {
  const content: string;
  export default content;
}
declare module '*.txt?raw' {
  const content: string;
  export default content;
}
declare module '*/_headers?raw' {
  const content: string;
  export default content;
}
