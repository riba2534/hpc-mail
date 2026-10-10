import type { MailboxAvailability, MailboxUnavailableReason } from '@hpc-mail/shared';

/** 去掉易混字符（0/o、1/l/i）的小写字母表，读出来、抄下来都不容易错 */
const LETTERS = 'abcdefghjkmnpqrstuvwxyz';
const ALPHANUMERIC = `${LETTERS}23456789`;

/** 随机前缀：字母开头、其余字母数字，满足 LOCAL_PART 规则且不会撞上保留前缀 */
export function randomLocalPart(length = 8, random: (n: number) => Uint32Array = randomValues): string {
  const values = random(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    const alphabet = i === 0 ? LETTERS : ALPHANUMERIC;
    result += alphabet[values[i]! % alphabet.length];
  }
  return result;
}

function randomValues(n: number): Uint32Array {
  return globalThis.crypto.getRandomValues(new Uint32Array(n));
}

const REASON_MESSAGES: Record<MailboxUnavailableReason, string> = {
  taken: '该地址已被占用，换一个前缀试试',
  reserved: '该前缀为系统保留，不能认领',
  quota: '你认领的地址数已达个人上限，释放不用的地址后再试',
  domain_limit: '你在该域名下的认领数已达上限，可换一个域名',
  domain_unavailable: '该域名当前不可认领（不存在或未对你开放）',
};

/** 不可认领时给用户看的原因；后端未给出 reason 时回退到通用提示 */
export function unavailableMessage(availability: Pick<MailboxAvailability, 'available' | 'reason'>): string | null {
  if (availability.available) return null;
  return availability.reason ? REASON_MESSAGES[availability.reason] : '该地址暂不可认领';
}
