import type { MessageAuth } from '@hpc-mail/shared';

/**
 * 未通过发件认证：有 Cloudflare 的可信结果，且显示的 From 没有对齐或 DMARC 明确失败。
 * 没有结果（null：历史邮件、站内互投；发件没有该字段）是「未知」，不当成失败。
 * 纯函数单独成模块：收件箱列表行也用它，不把详情页的横幅组件带进列表 chunk。
 */
export function senderAuthFailed(auth: MessageAuth | null | undefined): auth is MessageAuth {
  return !!auth && (!auth.aligned || auth.dmarc === 'fail');
}
