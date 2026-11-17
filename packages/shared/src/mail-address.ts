/** 解析后的邮件地址：address 已小写；name 为显示名（没有时为空串） */
export interface MailAddress {
  address: string;
  name: string;
}

/** 请求里可接受的地址写法：`a@b`、`Name <a@b>`、`"Doe, John" <a@b>`，或 `{ address, name? }` */
export type MailAddressInput = string | { address: string; name?: string };

/** 字符串写法（含显示名）的长度上限：超过直接拒绝，解析前就挡住超长输入 */
export const MAX_MAIL_ADDRESS_INPUT_LENGTH = 400;
/** 对象写法里显示名的原始长度上限（规整空白前；规整后另受 MAX_DISPLAY_NAME_LENGTH 约束） */
const MAX_RAW_NAME_LENGTH = 200;

/**
 * 地址里不允许的字符：空白与控制字符、`@` 以外的地址分隔与引用符号（尖括号、圆括号、方括号、反斜杠、
 * 逗号、分号、冒号、双引号）。这些字符写进 MIME 头会改变头结构（注入或拆成多个地址），一律拒绝；
 * 其余字符（含 UTF-8 本地部分与 IDN 域名）与上线前的地址校验口径一致。
 */
const LOCAL_PART = /^[^\s\u0000-\u001f\u007f@<>()[\]\\,;:"]+$/u;
const DOMAIN_LABEL = /^[\p{L}\p{N}\p{M}_-]+$/u;
/** 显示名不允许控制字符（含 CR/LF）与尖括号 */
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f<>]/;
/** 双引号显示名的内容：普通字符或反斜杠转义，不含未转义的引号（单遍匹配，无回溯放大） */
const QUOTED_NAME = /^(?:[^"\\]|\\.)*$/s;

/**
 * 地址校验（已小写的 addr-spec）：本地部分 1–64、域名至少两段且各段非空、顶级域至少 2 个字符，合计 ≤254。
 * 接受 UTF-8 本地部分与 IDN/punycode 域名；拒绝空白、控制字符与会改写邮件头结构的符号——
 * `alice<a@b.com` 这类畸形不再当成地址放行。只做线性扫描。
 */
export function isValidMailAddress(address: string): boolean {
  if (address.length > 254) return false;
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return false;
  const local = address.slice(0, at);
  if (local.length > 64 || !LOCAL_PART.test(local)) return false;
  const labels = address.slice(at + 1).split('.');
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return false;
  return [...labels[labels.length - 1]!].length >= 2;
}

function normalizeName(raw: string): string | null {
  // 换行等控制字符在规整空白前就拒绝（制表符按空白处理）
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(raw)) return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (BAD_NAME_CHARS.test(name)) return null;
  return name;
}

/**
 * 解析一个地址写法。成功返回 { address(小写), name }；格式不合法返回 null。
 * 字符串形式：纯地址，或「显示名 <地址>」（显示名可用双引号包起来，支持 \" 转义；名称与 < 之间空白可省）。
 * 先按长度上限拒绝，再用 lastIndexOf 定位尖括号，全程线性，病态输入不会放大成平方耗时。
 */
export function parseMailAddress(input: MailAddressInput): MailAddress | null {
  let address: string;
  let name = '';
  if (typeof input === 'string') {
    if (input.length > MAX_MAIL_ADDRESS_INPUT_LENGTH) return null;
    const text = input.trim();
    if (text.endsWith('>')) {
      const open = text.lastIndexOf('<');
      if (open < 0) return null;
      const rawName = text.slice(0, open).trim();
      let parsedName: string | null;
      if (rawName.startsWith('"')) {
        const inner = rawName.slice(1, -1);
        if (rawName.length < 2 || !rawName.endsWith('"') || !QUOTED_NAME.test(inner)) return null;
        parsedName = normalizeName(inner.replace(/\\(.)/gs, '$1'));
      } else {
        parsedName = rawName.includes('"') ? null : normalizeName(rawName);
      }
      if (parsedName === null) return null;
      name = parsedName;
      address = text.slice(open + 1, -1).trim();
    } else {
      address = text;
    }
  } else if (input && typeof input === 'object' && typeof input.address === 'string') {
    if (input.name !== undefined && typeof input.name !== 'string') return null;
    if (input.address.length > MAX_MAIL_ADDRESS_INPUT_LENGTH || (input.name?.length ?? 0) > MAX_RAW_NAME_LENGTH) return null;
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
