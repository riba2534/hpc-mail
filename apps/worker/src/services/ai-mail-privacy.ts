/**
 * 给外部模型的文本只带占位符。原值和占位符的对应关系保留在当前请求内。
 * URL 和地址先于验证码匹配，避免把链接中的标识误当作可选择的验证码。
 */
const URL = String.raw`(?:(?:[a-z][a-z\d+.-]*:)?\/\/|mailto:|www\.|(?<![\p{L}\p{N}_@])(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?=[:/?#]))[^\s<>"']+`;
const LOCAL_PART = String.raw`[\p{L}\p{N}.!#$%&'*+/=?^_\x60{|}~-]`;
const ADDRESS = String.raw`(?<!${LOCAL_PART})${LOCAL_PART}+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*`;
const CODE = String.raw`(?<![\w])(?:(?:[a-z\d][ \u00a0\-–]){3,}[a-z\d]|[a-z\d]{2,}(?:[\-–][a-z\d]{2,})+|[a-z\d]{4,}|[\p{Nd}]{4,})(?![\w])`;
const PRIVATE_VALUE = new RegExp(`(?:${URL}|${ADDRESS})|(${CODE})`, 'giu');
const NORMALIZE_CODE = /[ \u00a0\-–]/g;
const SHORT_CODE_LETTERS = /^[BCDFGHJKMNPQRTVWXY]{5}$/;

interface Secret {
  marker: string;
  value: string;
  code: string | null;
}

export interface MaskedMailText {
  text: string;
  prefix: string;
  secrets: Secret[];
}

function candidateCode(value: string): string | null {
  const compact = value.replace(NORMALIZE_CODE, '');
  if (/^\d{4,8}$/.test(compact)) return compact;
  if (SHORT_CODE_LETTERS.test(compact)) return compact;
  if (/^[a-z\d]{5,8}$/i.test(compact) && /\d/.test(compact) && /[a-z]/i.test(compact)) return compact.toUpperCase();
  return null;
}

export function maskMailForAi(segments: readonly string[]): MaskedMailText[] {
  // 同一批次的占位符全局唯一，原信也不能预先占用我们本次选择的命名空间。
  let prefix = '[[HPC_PRIVATE_';
  while (segments.some((text) => text.includes(prefix))) prefix += '_';

  return segments.map((segment, i) => {
    const secrets: Secret[] = [];
    const text = segment.replace(PRIVATE_VALUE, (value: string, candidate: string | undefined) => {
      const code = candidate ? candidateCode(candidate) : null;
      if (candidate && !code) {
        // 长编号也可能敏感。全字母的普通长词与短数字不当作长编号。
        const compact = candidate.replace(NORMALIZE_CODE, '');
        if (!/\p{Nd}/u.test(compact) || (!/\p{Nd}{4}/u.test(compact) && !/^[a-z\d]{9,}$/i.test(compact))) return value;
      }
      const marker = `${prefix}${i}_${secrets.length}]]`;
      secrets.push({ marker, value, code });
      return marker;
    });
    return { text, prefix, secrets };
  });
}

/** 模型改动、重复或跨段引用占位符时拒绝该输出。 */
export function restoreMailSecrets(translation: string, masked: MaskedMailText): string | null {
  const occurrences = translation.split(masked.prefix).slice(1).map((part) => masked.prefix + part.split(']]', 1)[0]! + ']]');
  const expected = new Set(masked.secrets.map(({ marker }) => marker));
  if (occurrences.length !== expected.size || new Set(occurrences).size !== expected.size
      || occurrences.some((marker) => !expected.has(marker))) return null;
  const values = new Map(masked.secrets.map(({ marker, value }) => [marker, value]));
  // 一次性替换，原值不会作为新的占位符再次解释。
  return translation.replace(/\[\[HPC_PRIVATE_+\d+_\d+\]\]/g, (marker) => values.get(marker) ?? marker);
}
