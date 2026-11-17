import type { Paths } from './openapi-common.js';

/**
 * API Key 可用的通知配置（/v1/notify-prefs*，notify.read / notify.write）与共享管理（/v1/mailboxes/shares*，mailbox.share）。
 * 需要的组件 schema 用 openapi-common 的 registerSchemas 在本模块顶层登记。
 * TODO(PR4a-notify)：实现
 */
export function accountKeyPaths(): Paths {
  return {};
}

/** 网页会话侧新增的公开路径：/api/forward-confirmations*。TODO(PR4a-notify)：实现 */
export function accountSessionPaths(): Paths {
  return {};
}
