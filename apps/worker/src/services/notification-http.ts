import { AppError } from '../lib/errors.js';

export const NOTIFICATION_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** 可诊断的投递错误；记录中不包含端点 URL、PushKey 或原始响应正文。 */
export class NotificationDeliveryError extends AppError {
  constructor(
    message: string,
    readonly httpStatus: number | null = null,
    readonly retryable = true,
  ) {
    super('internal', message);
    this.name = 'NotificationDeliveryError';
  }
}

async function readResponse(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new NotificationDeliveryError('通知服务响应超过大小上限', response.status, false);
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** 同一截止时间覆盖连接、响应头和响应体；即使 fetch mock/第三方不响应 abort 也会结束等待。 */
export async function notificationRequest(
  url: string,
  init: RequestInit,
  label: string,
  timeoutMs = NOTIFICATION_TIMEOUT_MS,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new NotificationDeliveryError(`${label}请求超时`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
        const text = await readResponse(response);
        if (!response.ok) {
          throw new NotificationDeliveryError(
            `${label} HTTP ${response.status}`,
            response.status ?? null,
            response.status === 429 || response.status >= 500,
          );
        }
        return { status: response.status, text };
      })(),
      expired,
    ]);
  } catch (error) {
    if (error instanceof AppError) throw error;
    // fetch 的异常文本可能回显完整 URL 或认证参数，不持久化原始错误。
    throw new NotificationDeliveryError(`${label}网络请求失败`);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
