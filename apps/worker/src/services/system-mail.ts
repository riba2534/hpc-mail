import { AppError } from '../lib/errors.js';
import { encodeBodyBase64 } from '../lib/mime.js';
import type { Env } from '../types.js';
import { getDomains } from './domain.js';

/**
 * 站点自己发出的系统信（目前只有转发目标确认信）：以 no-reply@首个系统域名 经 send_email 发出，
 * 带 Auto-Submitted 防自动回复。不经过用户外发配额与发件记录。
 */
export async function sendSystemMail(env: Env, mail: { to: string; subject: string; text: string; html: string }): Promise<void> {
  const [domain] = await getDomains(env);
  if (!domain) throw new AppError('validation_failed', '站点尚未配置系统域名，无法发送确认邮件');
  // 动态 import：`cloudflare:email`/`mimetext` 静态加载会让 vitest 的 workerd 崩（同 outbound.ts）
  const [{ EmailMessage }, { createMimeMessage }] = await Promise.all([import('cloudflare:email'), import('mimetext/browser')]);
  const from = `no-reply@${domain}`;
  const msg = createMimeMessage();
  msg.setSender({ name: 'HPC Mail', addr: from });
  msg.setRecipient(mail.to);
  msg.setSubject(mail.subject);
  msg.setHeader('Auto-Submitted', 'auto-generated');
  msg.addMessage({ contentType: 'text/plain', charset: 'UTF-8', encoding: 'base64', data: encodeBodyBase64(mail.text) });
  msg.addMessage({ contentType: 'text/html', charset: 'UTF-8', encoding: 'base64', data: encodeBodyBase64(mail.html) });
  await env.email.send(new EmailMessage(from, mail.to, msg.asRaw()));
}
