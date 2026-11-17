import { describe, expect, it } from 'vitest';
import { makePreview, PREVIEW_LIMIT } from '../src/lib/text.js';
import { extractCodeByRegex, resolveVerificationCode } from '../src/services/code-extract.js';

/**
 * R08 收紧后常见给码格式一度漏提（N1）。仿造样本，不含真实邮件内容。
 * 每条是 [主题, 正文, 应提出的码]。
 */
const POSITIVES: [string, string, string][] = [
  ['', 'Your code is 123456', '123456'],
  ['', '123456 is your Instagram code', '123456'],
  ['', 'Here is your code: 482913', '482913'],
  ['', 'Your PIN is 4829', '4829'],
  ['', 'Your Uber code: 4829. Never share this code.', '4829'],
  ['', 'Your Apple Account code is: 482913. Do not share it with anyone.', '482913'],
  ['', 'Code: 123456', '123456'],
  ['', 'Enter the code below:\n\n123456', '123456'],
  ['', 'Your code: 48291', '48291'],
  ['', 'Use code 482913', '482913'],
  ['', 'Use code 123456 to log in', '123456'],
  // 1900–2099 的 4 位码离关键词远、但不在日期或截止语境里
  ['', 'Your verification code is below:\n\n2048', '2048'],
  ['', 'Here is your verification code.\n\n2048\n\nIt expires soon.', '2048'],
  ['Your verification code', 'Hi,\n\n2048\n\nThanks', '2048'],
  ['', 'Your one-time PIN for login:\n1987', '1987'],
  ['', 'Your verification code for Acme is 2048', '2048'],
  // # / No. 紧跟给码说法时是码的写法
  ['', 'Your verification code: #482913', '482913'],
  ['', 'verification code\n\nNo. 482913', '482913'],
  ['', 'Your verification code: No. 482913', '482913'],
  ['', 'Your code: #482913', '482913'],
  // 州名缩写 + 5 位不像地址
  ['', 'Your verification code is NY 48291', '48291'],
  // 主干能提到、收紧后一度漏掉的其他写法
  ['', 'Enter this code to continue: 123456', '123456'],
  ['', 'Your Apple ID Code is: 123456.', '123456'],
  ['Welcome to GitHub', 'Your GitHub launch code: 12345678', '12345678'],
  ['', 'Your Microsoft account code: 1234567', '1234567'],
  ['', 'Your code 482913 expires in 2024 minutes', '482913'],
  ['', 'Your code 4829 - Netflix', '4829'],
  ['', 'Hi, here is the code you requested: 482913', '482913'],
  ['Sign in to Acme', 'Code 482913', '482913'],
  ['', 'Your code is:\n\n482913', '482913'],
  ['', 'Use 482913 as your code', '482913'],
  ['', 'Your code: 2025', '2025'],
  ['Your Cursor code', 'Enter the code below:\n482913', '482913'],
];

/** 不是验证码：邮编、截止年份、营销年份、编号、版权年份、优惠码。每条是 [说明, 主题, 正文, 应提出的码（空串为不提）] */
const NEGATIVES: [string, string, string, string][] = [
  ['邮编在验证码之前', '', 'Zip code 94103. Your verification code is 482913', '482913'],
  ['valid until 年份', '', 'Your verification code (valid until 2026): 482913', '482913'],
  ['城市逗号州名的地址', '', 'San Francisco, CA 94103. Your verification code: 48291', '48291'],
  ['地址在码之后', '', 'Your verification code is 48291\nSF, CA 94103', '48291'],
  ['订单号与码并存', '', 'Your order #482913 verification code is 777111', '777111'],
  ['账户编号与码并存', 'Verify', 'Your account no. 123456 code: 654321', '654321'],
  ['工单号在码之后', '', 'Your verification code is 482913. Ticket #12345', '482913'],
  ['版权年份', 'Your verification code', '© 2025 Acme', ''],
  ['跨行的版权年份', 'Your verification code', 'Copyright\n2026\nAcme', ''],
  ['截止秒数里的年份形状', '', 'Your verification code expires in 2026 seconds', ''],
  ['日期里的年份', '', "Your PIN code was changed on March 3, 2026. If this wasn't you call 1-800-555-0100", ''],
  ['无逗号的地址行', 'Your verification code', 'Your code is in the app.\n\nAcme Inc\n500 Howard Street\nSan Francisco CA 94105\n', ''],
  ['地址后跟国家', '', 'Your verification code is in the app. Acme, 1 Main St, Springfield, IL 62701, USA', ''],
  ['邀请码', '', 'Your invite code is 482913', ''],
  ['优惠码', '', 'Use the code SAVE20 at checkout', ''],
  ['结账用的数字优惠码', '', 'Use code 2026 at checkout for 20% off', ''],
  ['折扣说法', '', 'Your code 482913 gets you 20% off', ''],
  ['折扣码', '', 'Your discount code: 4821', ''],
  ['礼品码', '', 'Your gift code: 48291234', ''],
  ['订单码', '', 'Your order code: 4821', ''],
  ['营销信里的年份', 'Spring drop', 'The 2026 collection is here. Use code SPRING', ''],
  ['有验证语境的营销年份', 'Confirm your subscription', 'The 2026 collection is here. Use code SPRING', ''],
  ['PR 编号', '', 'Your code review: PR #4821', ''],
  ['离说法远的运行编号', '', 'Run failed for your code. Run 123456 failed', ''],
  ['日期写法', '', 'Your code: 2026年11月17日', ''],
  ['号码分段', '', 'Code: 4821-0001', ''],
  ['没有验证语境的字母数字码', '', 'Your code is F4K2P', ''],
];

describe('常见给码格式全部提到（N1）', () => {
  it.each(POSITIVES)('[%s] %j → %s', (subject, body, code) => {
    expect(extractCodeByRegex(subject, body)).toBe(code);
  });

  it.each(NEGATIVES)('%s', (_name, subject, body, code) => {
    expect(extractCodeByRegex(subject, body)).toBe(code);
  });

  /** 列表、wait 对没有存码的历史行用主题 + 160 字摘要重提，走同一套规则 */
  it.each(POSITIVES.filter(([, body]) => body.length < PREVIEW_LIMIT))('摘要重提：[%s] %j → %s', (subject, body, code) => {
    const preview = makePreview(body, '');
    expect(resolveVerificationCode(subject, preview, '', { bodyTruncated: preview.length >= PREVIEW_LIMIT })).toBe(code);
  });

  it.each(NEGATIVES.filter(([, , , code]) => code === ''))('摘要重提同样不提：%s', (_name, subject, body) => {
    expect(resolveVerificationCode(subject, makePreview(body, ''), '')).toBe('');
  });
});
