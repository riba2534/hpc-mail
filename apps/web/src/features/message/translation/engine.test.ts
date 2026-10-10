import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TRANSLATE_BATCH_CHARS, MAX_TRANSLATE_SEGMENT_CHARS, MAX_TRANSLATE_SEGMENTS } from '@hpc-mail/shared';
import { ApiError, toApiError } from '@/api/errors';
import { splitQuoteBlocks } from '@/lib/email-html/linkify';
import { isTranslatableSegment } from './detect';

const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/api/client', () => ({ api: { post: mocks.post } }));

import {
  applyHtmlTranslations,
  collectPlainTextSegments as collectBlocks,
  collectHtmlSegments as collectHtml,
  planBatches,
  restoreHtmlTranslations,
  startTranslation,
  textPieces,
  TRANSLATE_LIMITS,
  type TranslationSnapshot,
  translatePlainText,
  translationErrorMessage,
  withSubject as withSubjectBy,
} from './engine';

// 与 use-message-translation 的调用方式一致：纯文本先拆出引用块，片段按 detect.ts 过滤
const collectPlainTextSegments = (text: string) =>
  collectBlocks(splitQuoteBlocks(text).flatMap((block) => (block.type === 'text' ? [block.text] : [])), isTranslatableSegment);
const collectHtmlSegments = (root: Element) => collectHtml(root, isTranslatableSegment);
const withSubject = (subject: string, body: string[]) => withSubjectBy(subject, body, isTranslatableSegment);

/** 模拟服务端：每个片段译为「译:原文」 */
const echo = async (_path: string, body: { segments: string[] }) => ({
  translations: body.segments.map((segment) => `译:${segment}`),
  cached: false,
  skipped: 0,
});

function htmlRoot(html: string): HTMLElement {
  const doc = document.implementation.createHTMLDocument('');
  const root = doc.createElement('div');
  root.innerHTML = html;
  doc.body.append(root);
  return root;
}

beforeEach(() => {
  mocks.post.mockReset();
  mocks.post.mockImplementation(echo);
});

describe('限制与片段判定', () => {
  it('本地上限与 shared 契约一致', () => {
    expect(TRANSLATE_LIMITS).toEqual({
      segments: MAX_TRANSLATE_SEGMENTS,
      segmentChars: MAX_TRANSLATE_SEGMENT_CHARS,
      batchChars: MAX_TRANSLATE_BATCH_CHARS,
    });
  });

  it('跳过没有字母、纯链接、纯邮箱与中文片段', () => {
    expect(isTranslatableSegment('Hello world')).toBe(true);
    expect(isTranslatableSegment('2026-10-10 · 12:00 | ©')).toBe(false);
    expect(isTranslatableSegment('https://example.com/a?b=1')).toBe(false);
    expect(isTranslatableSegment('www.example.com')).toBe(false);
    expect(isTranslatableSegment('support@example.com')).toBe(false);
    expect(isTranslatableSegment('您的订单已发货')).toBe(false);
    expect(isTranslatableSegment('Visit https://example.com today')).toBe(true);
  });
});

describe('纯文本切段', () => {
  it('按空行切段、跳过引用块、相同段落只请求一次', () => {
    const text = 'Hi Alice,\n\nYour order has shipped.\nTrack it online.\n\n> Earlier message\n> quoted\n\nThanks\n\nHi Alice,';
    expect(collectPlainTextSegments(text)).toEqual(['Hi Alice,', 'Your order has shipped.\nTrack it online.', 'Thanks']);
  });

  it('超长段落按句子再切，每片不超过单段上限且是原文子串', () => {
    const paragraph = Array.from({ length: 120 }, (_, i) => `Sentence ${i} is part of a very long paragraph.`).join(' ');
    const segments = collectPlainTextSegments(paragraph);
    expect(segments.length).toBeGreaterThan(2);
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(MAX_TRANSLATE_SEGMENT_CHARS);
      expect(paragraph.includes(segment)).toBe(true);
      expect(segment.endsWith('.')).toBe(true);
    }
    // 无损：切片拼接即原文
    expect(textPieces(paragraph).map((piece) => piece.raw).join('')).toBe(paragraph);
  });

  it('没有句末标点时退到空白处或硬切', () => {
    const words = 'word '.repeat(900);
    expect(textPieces(words).every((piece) => piece.raw.length <= MAX_TRANSLATE_SEGMENT_CHARS)).toBe(true);
    const solid = 'x'.repeat(4500);
    expect(textPieces(solid).map((piece) => piece.raw.length)).toEqual([2000, 2000, 500]);
  });

  it('译文替换段落并保留空行与缩进；没有译文的段落保持原文', () => {
    const text = '  Hello there\n\nSecond line\n\n订单已发货';
    const translations = new Map([['Hello there', '你好']]);
    expect(translatePlainText(text, translations)).toBe('  你好\n\nSecond line\n\n订单已发货');
  });

  it('主题作为第一个片段，与正文重复时不再请求；中文主题不翻', () => {
    expect(withSubject(' Weekly digest ', ['Intro', 'Weekly digest'])).toEqual(['Weekly digest', 'Intro']);
    expect(withSubject('每周摘要', ['Intro'])).toEqual(['Intro']);
    expect(withSubject('', ['Intro'])).toEqual(['Intro']);
  });
});

describe('分批', () => {
  it('每批不超过 60 段', () => {
    const segments = Array.from({ length: 130 }, (_, i) => `Segment ${i}`);
    const batches = planBatches(segments);
    expect(batches.map((batch) => batch.length)).toEqual([60, 60, 10]);
    expect(batches.flat()).toEqual(segments);
  });

  it('每批不超过 6000 字符', () => {
    const segments = Array.from({ length: 7 }, (_, i) => `${i}`.padEnd(1500, 'a'));
    const batches = planBatches(segments);
    expect(batches.map((batch) => batch.length)).toEqual([4, 3]);
    for (const batch of batches) expect(batch.join('').length).toBeLessThanOrEqual(MAX_TRANSLATE_BATCH_CHARS);
  });
});

describe('HTML 文字节点', () => {
  it('收集时跳过代码、脚本、样式、表单、translate="no"、notranslate 与图片占位', () => {
    const root = htmlRoot(`
      <p>  Hello <b>world</b>  </p>
      <pre>const x = 1</pre><code>npm install</code><kbd>Ctrl</kbd><samp>Output text</samp>
      <textarea>Draft text</textarea><style>.a { color: red }</style>
      <div translate="no">Brand Name</div><span class="x notranslate">Keep me</span>
      <span class="remote-image-blocked">Logo alt</span>
      <p><a href="https://example.com">https://example.com</a> <span>support@example.com</span> <span>2026</span></p>
      <p>Hello</p><p>已经是中文</p>
    `);
    expect(collectHtmlSegments(root)).toEqual(['Hello', 'world']);
  });

  it('原位替换保留首尾空白，切回原文后完全复原', () => {
    const root = htmlRoot('<p>  Hello <b>world</b>!</p><p>Hello</p>');
    const before = root.innerHTML;
    applyHtmlTranslations(root, new Map([['Hello', '你好'], ['world', '世界']]));
    expect(root.innerHTML).toBe('<p>  你好 <b>世界</b>!</p><p>你好</p>');
    // 收集仍以原文为准
    expect(collectHtmlSegments(root)).toEqual(['Hello', 'world']);
    restoreHtmlTranslations(root);
    expect(root.innerHTML).toBe(before);
  });

  it('译文只作为文本写入，不会被解析成 HTML', () => {
    const root = htmlRoot('<p>Hello</p>');
    applyHtmlTranslations(root, new Map([['Hello', '<img src=x onerror=alert(1)>']]));
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('重新渲染出的新文档直接套用已有译文，不再请求', async () => {
    const client = new QueryClient();
    let snapshot: TranslationSnapshot | undefined;
    const first = htmlRoot('<p>Hello <b>world</b></p>');
    startTranslation({ queryClient: client, messageId: 1, view: undefined, segments: collectHtmlSegments(first), onChange: (s) => (snapshot = s) });
    await vi.waitFor(() => expect(snapshot?.running).toBe(false));
    applyHtmlTranslations(first, snapshot!.translations);
    expect(first.textContent).toBe('译:Hello 译:world');

    // 显示图片后 iframe 换了新文档
    const second = htmlRoot('<p>Hello <b>world</b><img alt=""></p>');
    applyHtmlTranslations(second, snapshot!.translations);
    expect(second.textContent).toBe('译:Hello 译:world');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    client.clear();
  });
});

describe('startTranslation', () => {
  let client: QueryClient;
  beforeEach(() => {
    client = new QueryClient();
  });
  afterEach(() => client.clear());

  const many = (count: number) => Array.from({ length: count }, (_, i) => `Segment number ${i}`);

  it('最多 3 批并发，每批返回即更新进度，按视图带 scope 参数', async () => {
    let inFlight = 0;
    let peak = 0;
    mocks.post.mockImplementation(async (path: string, body: { segments: string[] }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return echo(path, body);
    });
    const snapshots: TranslationSnapshot[] = [];
    startTranslation({ queryClient: client, messageId: 7, view: { scope: 'user', userId: 9 }, segments: many(300), onChange: (s) => snapshots.push(s) });
    await vi.waitFor(() => expect(snapshots.at(-1)?.running).toBe(false));
    expect(peak).toBe(3);
    expect(snapshots.map((s) => s.done)).toEqual([0, 1, 2, 3, 4, 5, 5]);
    expect(snapshots.at(-1)).toMatchObject({ total: 5, done: 5, failed: 0, error: null });
    expect(snapshots.at(-1)!.translations.get('Segment number 299')).toBe('译:Segment number 299');
    expect(mocks.post).toHaveBeenCalledWith(
      '/messages/7/translate',
      { segments: many(60) },
      expect.objectContaining({ query: { scope: 'user', userId: 9 } }),
    );
  });

  it('部分批次失败可只重试失败批次；同样内容再次翻译直接命中缓存', async () => {
    let calls = 0;
    mocks.post.mockImplementation(async (path: string, body: { segments: string[] }) => {
      calls += 1;
      if (calls === 2) throw new ApiError('upstream', { code: 'internal', httpStatus: 500 });
      return echo(path, body);
    });
    let snapshot: TranslationSnapshot | undefined;
    const run = startTranslation({ queryClient: client, messageId: 1, view: undefined, segments: many(120), onChange: (s) => (snapshot = s) });
    await vi.waitFor(() => expect(snapshot?.running).toBe(false));
    expect(snapshot).toMatchObject({ total: 2, done: 1, failed: 1, error: '翻译服务暂时不可用，请稍后重试' });

    run.retry();
    await vi.waitFor(() => expect(snapshot).toMatchObject({ running: false, done: 2, failed: 0, error: null }));
    expect(mocks.post).toHaveBeenCalledTimes(3);

    let again: TranslationSnapshot | undefined;
    startTranslation({ queryClient: client, messageId: 1, view: undefined, segments: many(120), onChange: (s) => (again = s) });
    await vi.waitFor(() => expect(again).toMatchObject({ running: false, done: 2 }));
    expect(mocks.post).toHaveBeenCalledTimes(3);
  });

  it('额度用完时停止派发剩余批次，剩余批次记为失败', async () => {
    mocks.post.mockRejectedValue(new ApiError('今日翻译额度已用完', { code: 'rate_limited', httpStatus: 429 }));
    let snapshot: TranslationSnapshot | undefined;
    startTranslation({ queryClient: client, messageId: 1, view: undefined, segments: many(600), onChange: (s) => (snapshot = s) });
    await vi.waitFor(() => expect(snapshot?.running).toBe(false));
    expect(mocks.post).toHaveBeenCalledTimes(3);
    expect(snapshot).toMatchObject({ total: 10, done: 0, failed: 10, error: '今日翻译额度已用完' });
  });

  it('取消后不再派发、不再回调', async () => {
    const onChange = vi.fn();
    const run = startTranslation({ queryClient: client, messageId: 1, view: undefined, segments: many(600), onChange });
    run.cancel();
    const calls = onChange.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).toHaveBeenCalledTimes(calls);
    expect(mocks.post).toHaveBeenCalledTimes(3);
  });

  it('译文条数与片段对不上时视为失败', async () => {
    mocks.post.mockResolvedValue({ translations: ['只有一条'], cached: false, skipped: 0 });
    let snapshot: TranslationSnapshot | undefined;
    startTranslation({ queryClient: client, messageId: 1, view: undefined, segments: ['One', 'Two'], onChange: (s) => (snapshot = s) });
    await vi.waitFor(() => expect(snapshot?.running).toBe(false));
    expect(snapshot).toMatchObject({ failed: 1, error: '翻译结果与原文对不上，请重试' });
    expect(snapshot!.translations.size).toBe(0);
  });
});

describe('translationErrorMessage', () => {
  it('按状态码与客户端错误码映射文案', () => {
    expect(translationErrorMessage(new ApiError('x', { code: 'forbidden', httpStatus: 403 }))).toBe('管理员未启用 AI 翻译');
    expect(translationErrorMessage(new ApiError('今日翻译额度已用完', { code: 'rate_limited', httpStatus: 429 }))).toBe('今日翻译额度已用完');
    expect(translationErrorMessage(new ApiError('请求过快', { code: 'rate_limited', httpStatus: 429 }))).toBe('翻译请求过于频繁，请稍后再试');
    expect(translationErrorMessage(new ApiError('boom', { code: 'internal', httpStatus: 500 }))).toBe('翻译服务暂时不可用，请稍后重试');
    expect(translationErrorMessage(toApiError(new TypeError('Failed to fetch')))).toBe('网络连接失败，请检查网络后重试');
    expect(translationErrorMessage(new ApiError('x', { code: 'timeout' }))).toBe('翻译超时，请重试');
    expect(translationErrorMessage(new Error('x'))).toBe('翻译失败，请重试');
  });
});
