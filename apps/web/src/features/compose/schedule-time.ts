const pad = (n: number) => String(n).padStart(2, '0');

/** Date → `<input type="datetime-local">` 的值（本地时区，精确到分钟） */
export function toLocalInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** datetime-local 的值按本地时区解析；格式不对或日期不存在时返回 null */
export function parseLocalInputValue(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(year, month - 1, day, hour, minute);
  // 2 月 30 日之类会被 Date 顺延，与输入对不上即视为无效
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

/** 带本地时区偏移的 ISO 8601（如 2026-11-18T09:00:00+08:00），服务端按偏移换算，不受服务器时区影响 */
export function toOffsetIsoString(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${toLocalInputValue(date)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 定时发送的默认时间：一小时后，向上取整到 5 分钟 */
export function defaultScheduleTime(now = Date.now()): Date {
  const step = 5 * 60_000;
  return new Date(Math.ceil((now + 60 * 60_000) / step) * step);
}
