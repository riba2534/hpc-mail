const pad = (n: number): string => String(n).padStart(2, '0');

/** 相对时间（中文）：刚刚 / n 分钟前 / n 小时前 / 昨天 HH:mm / n 天前 / YYYY-MM-DD */
export function formatRelativeTime(input: string | number | Date, now = Date.now()): string {
  const date = new Date(input);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) return '';
  const diff = now - ms;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diff < 0) return formatDateTime(date);
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;

  const sameYear = new Date(now).getFullYear() === date.getFullYear();
  return sameYear
    ? `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 完整日期时间：YYYY-MM-DD HH:mm */
export function formatDateTime(input: string | number | Date): string {
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 字节数（中文可读）：B / KB / MB / GB */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  const rounded = exponent === 0 ? value : Math.round(value * 10) / 10;
  return `${rounded} ${units[exponent]}`;
}
