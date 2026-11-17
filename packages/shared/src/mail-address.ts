/** 解析后的邮件地址：address 已小写；name 为显示名（没有时为空串） */
export interface MailAddress {
  address: string;
  name: string;
}

/** 请求里可接受的地址写法：`a@b`、`Name <a@b>`、`"Doe, John" <a@b>`，或 `{ address, name? }` */
export type MailAddressInput = string | { address: string; name?: string };

const ATEXT = "a-z0-9!#$%&'*+/=?^_`{|}~-";
const LOCAL_PART = new RegExp(`^[${ATEXT}]+(?:\\.[${ATEXT}]+)*$`);
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
/** 显示名不允许控制字符（含 CR/LF）与尖括号 */
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f<>]/;

/**
 * 严格的地址校验（已小写的 addr-spec）：dot-atom 本地部分 ≤64、域名各标签 1–63、顶级域为字母或 punycode，
 * 合计 ≤254。不接受引号本地部分、IP 字面量与任何空白、尖括号、逗号——`alice<a@b.com>` 这类畸形不再当成地址放行。
 */
export function isValidMailAddress(address: string): boolean {
  if (address.length > 254) return false;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local)) return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  return TLD.test(labels[labels.length - 1]!);
}

function normalizeName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (BAD_NAME_CHARS.test(name)) return null;
  return name;
}

/**
 * 解析一个地址写法。成功返回 { address(小写), name }；格式不合法返回 null。
 * 字符串形式：纯地址，或「显示名 <地址>」（显示名可用双引号包起来，支持 \" 转义；名称与 < 之间空白可省）。
 */
export function parseMailAddress(input: MailAddressInput): MailAddress | null {
  let address: string;
  let name = '';
  if (typeof input === 'string') {
    const text = input.trim();
    const angle = /^(?:"((?:[^"\\\r\n]|\\.)*)"|([^"<>\r\n]*?))\s*<([^<>]*)>$/.exec(text);
    if (angle) {
      const quoted = angle[1];
      const parsedName = normalizeName(quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : angle[2] ?? '');
      if (parsedName === null) return null;
      name = parsedName;
      address = angle[3]!.trim();
    } else {
      address = text;
    }
  } else if (input && typeof input === 'object' && typeof input.address === 'string') {
    if (input.name !== undefined && typeof input.name !== 'string') return null;
    const parsedName = normalizeName(input.name ?? '');
    if (parsedName === null) return null;
    name = parsedName;
    address = input.address.trim();
  } else {
    return null;
  }
  address = address.toLowerCase();
  if (!isValidMailAddress(address)) return null;
  return { address, name };
}

/** 显示用：有显示名时 `Name <a@b>`，否则纯地址（不做 RFC 2047 编码，写 MIME 头由发信端负责） */
export function formatMailAddress(value: MailAddress): string {
  return value.name ? `${value.name} <${value.address}>` : value.address;
}
