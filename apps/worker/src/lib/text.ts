/**
 * 零宽、软连字符、方向控制等不可见字符：渲染时不占位，却常被反爬插在验证码中间，
 * 换成空格会把码切成两段（`913472` → `91347 2`，提码只剩 5 位），只能直接去掉。
 */
const ZERO_WIDTH = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060\\uFEFF\\u00AD\\u034F]",
  "g",
);

/** 不间断空格 / 全角空格渲染时真的占位，折叠为普通空格 */
const WIDE_SPACE = new RegExp("[\\u00A0\\u3000]", "g");

/**
 * 去掉不可见字符。text/plain 正文不经过 {@link htmlToText}，提码前要自己归一化，
 * 否则 6 位码被零宽空格分开后只会命中前 5 位。
 */
export function stripInvisible(text: string): string {
  return text.replace(ZERO_WIDTH, '');
}

/**
 * 行内文字格式标签不产生空白：验证码常被它们从中间切开
 * （`<b>913</b>472`、`9134<font>72</font>`、`<wbr>`），按空格剥离同样只剩一截。
 * 其余标签（含 td/table 这类结构标签）仍按空格处理，避免把相邻单元格粘成一个词。
 */
const INLINE_TAG =
  /<\/?(?:b|bdi|bdo|big|code|del|em|font|i|ins|kbd|mark|nobr|s|samp|small|span|strike|strong|sub|sup|tt|u|var|wbr)(?:\s[^>]*)?\/?>/gi;

/** 数字 / 十六进制实体：反爬常用 `&#8203;`（零宽空格）之类把验证码拆开 */
const NUMERIC_ENTITY = /&#x([0-9a-f]+);|&#(\d+);/gi;

/** 解码成字母数字的零宽命名实体，与 {@link ZERO_WIDTH} 同样直接去掉 */
const ZERO_WIDTH_ENTITY = /&(?:zwnj|zwj|shy|lrm|rlm);/gi;

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/**
 * htmlToText 只处理开头这么多字符。收件解析在 SMTP Ack 前同步转换，输入来自任意外部发件人；
 * 下游最多用到提码 16KB、通知 4000 字、验证链接 200KB 原文，512KB 绰绰有余。
 */
export const HTML_TO_TEXT_MAX_CHARS = 512 * 1024;

/**
 * 截断前先清掉不产生文字的大块内容，免得开头一张内嵌图片就占满上限、把后面的正文（验证码）挤出去：
 * 超长的带引号属性值（data: 图片、巨型 style 等）清空，未加引号或在 CSS url() 里的超长 data: URI 去掉载荷。
 * 两条正则都只在 `="`、`data:` 处起扫，扫到第一个终止字符为止，整体线性。
 */
const LONG_ATTRIBUTE_VALUE = /=\s*(?:"[^"]{4096,}"|'[^']{4096,}')/g;
const LONG_DATA_URI = /\bdata:[^\s"'<>)]{1024,}/gi;
/** 截断或实体解码留下的孤立代理字符 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * 只处理最后一个 `>` 之前的部分：之后不可能有完整标签，`<[^>]+>` 这类正则在没有 `>` 的长串上
 * 会对每个 `<` 都扫到结尾，退化成平方耗时（64KB 的 `<a <a …` 约 0.7 秒，256KB 约 12 秒）。
 * 前一步替换可能删掉末尾的 `>`，所以每一步都重新切分。
 */
function withinMarkup(source: string, transform: (markup: string) => string): string {
  const end = source.lastIndexOf('>') + 1;
  return transform(source.slice(0, end)) + source.slice(end);
}

/**
 * 剥离 script/style/head/template 这类内容不算正文的元素（开闭标签之间整段丢弃），线性实现。
 * 等价的单条正则 `<(…)[^>]*>[\s\S]*?<\/\1\s*>` 遇到没有闭标签的开标签会从每个开标签扫到结尾，重复的 `<style>` 即可平方退化；
 * 这里某种标签找不到闭标签后，之后同名的开标签也不可能再闭合，直接跳过。
 */
function stripRawBlocks(source: string): string {
  const unclosed = new Set<string>();
  const open = /<(script|style|head|template)\b[^>]*>/gi;
  let out = '';
  let kept = 0;
  for (let match = open.exec(source); match; match = open.exec(source)) {
    const name = match[1]!.toLowerCase();
    if (unclosed.has(name)) continue;
    const close = new RegExp(`</${name}\\s*>`, 'gi');
    close.lastIndex = open.lastIndex;
    const closed = close.exec(source);
    if (!closed) {
      unclosed.add(name);
      continue;
    }
    out += `${source.slice(kept, match.index)} `;
    kept = open.lastIndex = closed.index + closed[0].length;
  }
  return out + source.slice(kept);
}

/** htmlToText 依次执行的标签处理，每一步都经 withinMarkup 重新切分 */
const MARKUP_STEPS: Array<(markup: string) => string> = [
  stripRawBlocks,
  (markup) => markup.replace(/<br\s*\/?>/gi, '\n'),
  (markup) => markup.replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n'),
  (markup) => markup.replace(INLINE_TAG, ''),
  (markup) => markup.replace(/<[^>]+>/g, ' '),
];

/** HTML 转换出的纯文本；truncated 表示去掉大块内容后仍超过上限，只转换了开头 */
export interface HtmlText {
  text: string;
  truncated: boolean;
}

/** 无依赖的 HTML → 纯文本（收件解析与摘要用，禁止引入 linkedom 等重依赖） */
export function convertHtmlToText(html: string | undefined | null): HtmlText {
  const compact = String(html || '').replace(LONG_ATTRIBUTE_VALUE, '=""').replace(LONG_DATA_URI, 'data:');
  let source = compact.slice(0, HTML_TO_TEXT_MAX_CHARS);
  const truncated = compact.length > source.length;
  if (truncated) {
    // 截断点落在标签中间时丢掉这段残缺的标签，不把属性当正文
    const open = source.lastIndexOf('<');
    if (open > source.lastIndexOf('>')) source = source.slice(0, open);
  }
  const text = MARKUP_STEPS.reduce((markup, step) => withinMarkup(markup, step), source)
    .replace(/&nbsp;/gi, ' ')
    .replace(ZERO_WIDTH_ENTITY, '')
    // 数字实体先于 &amp; 解码，避免把 `&amp;#8203;` 这种字面量当成零宽空格
    .replace(NUMERIC_ENTITY, (_m, hex: string | undefined, dec: string | undefined) =>
      safeChar(hex === undefined ? Number.parseInt(dec ?? '', 10) : Number.parseInt(hex, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(ZERO_WIDTH, '')
    .replace(WIDE_SPACE, ' ')
    .replace(LONE_SURROGATE, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, truncated };
}

export function htmlToText(html: string | undefined | null): string {
  return convertHtmlToText(html).text;
}

function previewOf(source: string, limit: number): string {
  // 纯文本正文里的零宽字符同样会切断验证码：摘要是列表接口重新校验提码的输入
  return source.replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * 摘要默认长度。列表接口拿摘要重新校验提码，取到这个长度就说明正文被截断过，
 * 末尾的候选可能已经少了几位，见 code-extract 的 bodyTruncated。
 */
export const PREVIEW_LIMIT = 160;

/** 正文纯文本摘要：优先纯文本，回落 html→text，截断到 limit 字符 */
export function makePreview(
  text: string | undefined | null,
  html: string | undefined | null,
  limit = PREVIEW_LIMIT,
): string {
  return previewOf((text && text.trim()) || htmlToText(html), limit);
}

/** 同一封信的正文文本视图，见 {@link mailText} */
export interface MailText {
  /** 纯文本优先、缺失时回落 HTML 转换结果（提码、AI 兜底、通知与转发正文的口径） */
  readonly plain: string;
  /** plain 来自 HTML 转换且超长只转换了开头 */
  readonly plainTruncated: boolean;
  /** 与 makePreview 相同的摘要 */
  preview(limit?: number): string;
}

/**
 * HTML → 纯文本惰性转换且最多一次：大 HTML 整段转换是收件链路最重的 CPU，
 * 提码、预览、AI 兜底、通知与中转转发共用这一份结果。
 */
export function mailText(text: string, html: string): MailText {
  let converted: HtmlText | undefined;
  const htmlText = () => (converted ??= convertHtmlToText(html));
  return {
    get plain() { return text || htmlText().text; },
    get plainTruncated() { return !text && htmlText().truncated; },
    preview: (limit = PREVIEW_LIMIT) => previewOf((text && text.trim()) || htmlText().text, limit),
  };
}
