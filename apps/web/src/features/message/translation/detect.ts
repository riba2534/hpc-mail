/** 只取开头一段判定语言：开头足以代表主体语言，大邮件也不必整封跑 Unicode 正则 */
const SAMPLE_CHARS = 20_000;
/** 汉字占字母类字符的比例达到该值，视为中文内容，不再提供翻译 */
const CHINESE_RATIO = 0.3;

/**
 * 汉字在字母类字符（任何文字的字母，不含数字、标点与空白）中的占比；没有字母时返回 null。
 * 假名、谚文不计入汉字，日文、韩文邮件照常可以翻译成中文。
 */
export function hanRatio(text: string): number | null {
  const sample = text.slice(0, SAMPLE_CHARS);
  const letters = sample.match(/\p{L}/gu)?.length ?? 0;
  if (letters === 0) return null;
  return (sample.match(/\p{Script=Han}/gu)?.length ?? 0) / letters;
}

/** 有字母且主要不是中文 */
export function needsTranslation(text: string): boolean {
  const ratio = hanRatio(text);
  return ratio !== null && ratio < CHINESE_RATIO;
}

/** HTML → 粗略可见文字，只用于语言判定：去掉 head/style/script 等块、标签与实体 */
export function roughHtmlText(html: string): string {
  return html
    .replace(/<(head|style|script|noscript|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:#\d+|#x[\da-f]+|[a-z]+);/gi, ' ');
}

const URL_OR_EMAIL = /^(?:(?:https?:\/\/|www\.)\S+|mailto:\S+|[^\s@]+@[^\s@]+\.[^\s@]+)$/i;

/** 单个片段是否送去翻译：有字母、不是纯链接或邮箱、也不已经是中文 */
export function isTranslatableSegment(segment: string): boolean {
  return !URL_OR_EMAIL.test(segment) && needsTranslation(segment);
}

/** 详情页是否提供「翻译」：按实际展示的正文（HTML 优先）判定；正文为空不提供 */
export function messageNeedsTranslation(message: { bodyHtml: string; bodyText: string }): boolean {
  return needsTranslation(message.bodyHtml ? roughHtmlText(message.bodyHtml) : message.bodyText);
}
