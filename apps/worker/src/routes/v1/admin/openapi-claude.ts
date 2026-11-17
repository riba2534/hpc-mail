import { CLAUDE_TIERS, MAX_ADMIN_LOOKUP } from '@hpc-mail/shared';
import {
  array, bool, date, domainName, int, nullable, object, operation, positiveId, query, ref, registerSchemas, str, type Paths,
} from '../../openapi-common.js';

const tier = { ...nullable({ type: 'string', enum: [...CLAUDE_TIERS] }),
  description: 'Max plan inferred from the amount: 10000 cents is 5x, 20000 is 20x; any other or unknown amount is null.' };
const address = { type: 'string', minLength: 3, maxLength: 318, description: 'Normalized lowercase address.', examples: ['alice@example.org'] };

registerSchemas({
  ClaudeReceipt: object({
    messageId: { ...nullable(positiveId), description: 'Source message id; null once the message was permanently deleted (the receipt itself is kept).' },
    receivedAt: date,
    subject: str,
    amountCents: { ...nullable(int), description: 'Amount paid in cents, from "Amount paid $X" or the "Receipt from Anthropic, PBC $X" header; null when not recognized.' },
    currency: { ...nullable(str), description: 'ISO 4217 code inferred from the currency symbol ($ is USD).' },
    tier,
    cardLast4: { ...nullable({ type: 'string', pattern: '^[0-9]{4}$' }), description: 'Last four digits of the charged card ("with - 1234").' },
  }),
  ClaudeDomainFacts: object({
    domain: domainName,
    addresses: { ...int, description: 'Addresses with a Claude account fact (welcome, receipt, subscription, suspension or product mail from Anthropic).' },
    paid: { ...int, description: 'Of those, addresses that received a receipt or subscription confirmation.' },
    suspended: { ...int, description: 'Of those, addresses that received a suspension notice.' },
    suspendedAddresses: array(object({ address, suspendedAt: nullable(date) })),
  }),
  ClaudeAddressFacts: object({
    address,
    domain: domainName,
    known: { ...bool, description: 'Whether any Anthropic mail, account fact or receipt is on record for the address.' },
    firstSeenAt: nullable(date),
    paid: { ...bool, description: 'A receipt or subscription confirmation was received.' },
    suspended: bool,
    suspendedAt: nullable(date),
    anthropicMails: { ...int, description: 'Incoming mail from anthropic.com, claude.com or their subdomains, trash included, permanently deleted excluded. Greater than 0 means the address has been used to register or sign in to Claude.' },
    lastAnthropicMailAt: nullable(date),
    loginLinkMails: { ...int, description: 'Of those, sign-in link mail (subject starting with "Secure link to log in to Claude" or "Your secure link to Claude").' },
    receipts: { ...array(ref('ClaudeReceipt')), description: 'Oldest first.' },
    tier: { ...tier, description: 'Tier of the most recent receipt whose amount was recognized.' },
  }),
});

const trust = 'Requires an administrator account key with the admin scope; read-only. Facts and receipts only come from authenticated official Anthropic mail (exact sender domain allowlist, DKIM aligned with the sender, the address in the To header); mail received before authentication results were recorded (2026-11-17) counts by sender domain and subject. They survive permanent deletion of the mail.';
const lookup = (name: string, example: string) => query(name, { type: 'string', minLength: 1, examples: [example] },
  `Comma-separated ${name}, 1–${MAX_ADMIN_LOOKUP} after trimming and de-duplication; matched case-insensitively.`, true);

const domainExample = { domain: 'example.org', addresses: 12, paid: 9, suspended: 2,
  suspendedAddresses: [{ address: 'bob@example.org', suspendedAt: '2026-11-02T08:15:00.000Z' }, { address: 'carol@example.org', suspendedAt: '2026-11-10T03:40:00.000Z' }] };
const addressExample = { address: 'alice@example.org', domain: 'example.org', known: true, firstSeenAt: '2026-10-17T09:00:00.000Z', paid: true,
  suspended: false, suspendedAt: null, anthropicMails: 6, lastAnthropicMailAt: '2026-11-17T09:02:00.000Z', loginLinkMails: 3,
  receipts: [{ messageId: 1024, receivedAt: '2026-10-17T09:05:00.000Z', subject: 'Your receipt from Anthropic, PBC #2002-6773-4161',
    amountCents: 10000, currency: 'USD', tier: '5x', cardLast4: '4242' }], tier: '5x' };

/** /v1/admin 的 Claude 事实与收据：管理员 Key（管理员账户 + admin scope），只读 */
export function adminClaudePaths(): Paths {
  return {
    '/admin/claude/domains': {
      get: operation('listClaudeDomainFacts', 'Summarize Claude account facts per domain', array(ref('ClaudeDomainFacts')), {
        scope: 'admin', parameters: [lookup('domains', 'example.org,unused.example')],
        example: [domainExample, { domain: 'unused.example', addresses: 0, paid: 0, suspended: 0, suspendedAddresses: [] }],
        description: `One entry per requested domain, in request order; a domain without any fact returns zero counts. suspendedAddresses is ordered by suspension time. ${trust}` }),
    },
    '/admin/claude/addresses': {
      get: operation('listClaudeAddressFacts', 'Read Claude facts, sign-in mail and receipts per address', array(ref('ClaudeAddressFacts')), {
        scope: 'admin', parameters: [lookup('addresses', 'alice@example.org,new@example.org')],
        example: [addressExample, { address: 'new@example.org', domain: 'example.org', known: false, firstSeenAt: null, paid: false, suspended: false,
          suspendedAt: null, anthropicMails: 0, lastAnthropicMailAt: null, loginLinkMails: 0, receipts: [], tier: null }],
        description: `One entry per requested address, in request order; an address with no Anthropic mail, fact or receipt returns known=false. anthropicMails, lastAnthropicMailAt and loginLinkMails count mail still stored (trash included) by sender domain; receipts are parsed from receipt mail (amount, currency, card last four) and kept after the mail is deleted. ${trust}` }),
    },
  };
}
