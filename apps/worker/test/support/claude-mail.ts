import type { MessageAuth } from '@hpc-mail/shared';
import { env } from 'cloudflare:test';
import { createDb } from '../../src/db/client.js';
import { messages } from '../../src/db/schema.js';

/** 收件时 Cloudflare 判定 DKIM 通过、签名域即发件域的认证结果（真实官方来信的样子） */
export function signedBy(fromAddress: string, overrides: Partial<MessageAuth> = {}): MessageAuth {
  const domain = fromAddress.slice(fromAddress.lastIndexOf('@') + 1).toLowerCase();
  return { spf: 'pass', dkim: 'pass', dkimDomain: domain, dmarc: 'pass', aligned: true, ...overrides };
}

/** 默认是通过认证、To 头即收件地址的来信；extra 可覆盖 auth、recipients 与其他列 */
export async function receiveSigned(address: string, fromAddress: string, subject: string, extra: Partial<typeof messages.$inferInsert> = {}) {
  return (await createDb(env).insert(messages).values({
    address, domain: address.split('@')[1]!, direction: 'inbound', status: 'received', fromAddress, subject,
    auth: signedBy(fromAddress), recipients: { to: [address], cc: [], bcc: [] }, ...extra,
  }).returning().get())!;
}
