import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MessageDetail } from '@hpc-mail/shared';
import { preloadable } from '@/app/route-modules';
import { toast } from '@/components/ui/toast';
import type { MailView } from '@/features/inbox/mail-view';
import { splitQuoteBlocks } from '@/lib/email-html/linkify';
import { usePublicConfig } from '@/lib/use-config';
import { isTranslatableSegment, messageNeedsTranslation } from './detect';
import type { TranslationRun, TranslationSnapshot } from './engine';

/**
 * 切段、分批请求与 DOM 替换在 engine.ts，点击「翻译」时才加载，不进详情页首屏 chunk。
 * 引擎只依赖入口 chunk 里的模块；它若引用 components/ui 的 Button、Spinner 等，打包器会把这些
 * 连同 cn 从入口 chunk 拆出去，登录页反而多一个请求，所以状态条留在详情页。
 */
export const loadTranslation = preloadable(() => import('./engine'));
type TranslationModule = Awaited<ReturnType<typeof loadTranslation>>;

interface Session {
  /** 邮件与可见性上下文；切到别的邮件时旧会话自然失效，不会闪出上一封的译文 */
  key: string;
  mode: 'original' | 'translated';
  snapshot: TranslationSnapshot | null;
}

export interface MessageTranslationState {
  /** 站点启用了翻译且正文主要不是中文 */
  available: boolean;
  translated: boolean;
  snapshot: TranslationSnapshot | null;
  /** 译文主题；未翻译或主题无需翻译时为 undefined */
  subject: string | undefined;
  /** 纯文本正文的文字块 → 译文（交给 PlainTextBody） */
  transformText: ((text: string) => string) | undefined;
  toggle(): void;
  retry(): void;
}

/**
 * 邮件详情的「翻译成简体中文」。HTML 正文传入 iframe 内的正文根节点：译文原位写入文字节点，
 * iframe 因显示图片等原因重新渲染后，用已有的「原文 → 译文」重新套用，不重复请求。
 */
export function useMessageTranslation(
  message: MessageDetail | undefined,
  view: MailView | undefined,
  htmlRoot: HTMLElement | null,
): MessageTranslationState {
  const queryClient = useQueryClient();
  const { data: config } = usePublicConfig();
  const bodyHtml = message?.bodyHtml ?? '';
  const bodyText = message?.bodyText ?? '';
  const translatable = useMemo(() => messageNeedsTranslation({ bodyHtml, bodyText }), [bodyHtml, bodyText]);
  const available = Boolean(message && config?.translationEnabled && translatable);
  const key = message ? `${message.id}|${view?.scope ?? ''}|${view?.userId ?? ''}` : '';

  const [session, setSession] = useState<Session | null>(null);
  const runRef = useRef<{ key: string; run: TranslationRun } | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const htmlRootRef = useRef(htmlRoot);
  htmlRootRef.current = htmlRoot;

  const current = session?.key === key ? session : null;
  const translated = current?.mode === 'translated';
  const translations = translated ? current.snapshot?.translations : undefined;
  const translator = loadTranslation.peek();

  // 换邮件或离开详情：停止派发旧邮件剩余批次（在途请求照常写入缓存，回来再译时直接命中）
  useEffect(
    () => () => {
      runRef.current?.run.cancel();
      runRef.current = null;
    },
    [key],
  );

  const update = (sessionKey: string, patch: Partial<Session>) =>
    setSession((prev) => (prev?.key === sessionKey ? { ...prev, ...patch } : prev));

  const abort = (sessionKey: string, title: string) => {
    update(sessionKey, { mode: 'original' });
    toast({ title });
  };

  const begin = (loaded: TranslationModule, sessionKey: string) => {
    if (!message || keyRef.current !== sessionKey) return;
    const root = message.bodyHtml ? htmlRootRef.current : null;
    if (message.bodyHtml && !root) return abort(sessionKey, '正文尚未加载完成，请稍后重试');
    const run = loaded.translateMessage({
      queryClient,
      messageId: message.id,
      view,
      subject: message.subject,
      root,
      // 纯文本按 PlainTextBody 的拆法取非引用文字块，切段结果才能和渲染对上
      textBlocks: root ? [] : splitQuoteBlocks(message.bodyText).flatMap((block) => (block.type === 'text' ? [block.text] : [])),
      accept: isTranslatableSegment,
      onChange: (snapshot) => update(sessionKey, { snapshot }),
    });
    if (run) runRef.current = { key: sessionKey, run };
    else abort(sessionKey, '没有需要翻译的内容');
  };

  const toggle = () => {
    if (!available) return;
    if (translated) return update(key, { mode: 'original' });
    // 本封已有翻译进度：直接切回译文
    if (current && runRef.current?.key === key) return update(key, { mode: 'translated' });
    const sessionKey = key;
    setSession({ key: sessionKey, mode: 'translated', snapshot: null });
    if (translator) return begin(translator, sessionKey);
    loadTranslation().then(
      (loaded) => begin(loaded, sessionKey),
      () => abort(sessionKey, '翻译模块加载失败，请检查网络后重试'),
    );
  };

  // HTML 正文：切换译文/原文，或 iframe 换了新文档时，把映射套到当前文档上
  useEffect(() => {
    if (!translator || !htmlRoot) return;
    if (translations) translator.applyHtmlTranslations(htmlRoot, translations);
    else translator.restoreHtmlTranslations(htmlRoot);
  }, [translator, htmlRoot, translations]);

  const transformText = useMemo(
    () => (translator && translations ? (text: string) => translator.translatePlainText(text, translations) : undefined),
    [translator, translations],
  );

  return {
    available,
    translated,
    snapshot: translated ? current.snapshot : null,
    subject: message ? translations?.get(message.subject.trim()) : undefined,
    transformText,
    toggle,
    retry: () => {
      if (runRef.current?.key === key) runRef.current.run.retry();
    },
  };
}
