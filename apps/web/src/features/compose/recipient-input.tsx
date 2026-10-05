import { X } from 'lucide-react';
import { type ClipboardEvent, type KeyboardEvent, useId, useState } from 'react';
import { emailAddressSchema } from '@hpc-mail/shared';
import { cn } from '@/lib/cn';

export interface RecipientInputProps {
  value: string[];
  onChange: (value: string[]) => void;
  id?: string;
  placeholder?: string;
  /** 近期联系人建议（原生 datalist 自动补全） */
  suggestions?: string[];
  'aria-describedby'?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
}

export function RecipientInput({
  value,
  onChange,
  id,
  placeholder,
  suggestions,
  ...aria
}: RecipientInputProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const errorId = `${listId}-error`;

  const addToken = (raw: string) => {
    const candidate = raw.trim().replace(/[,;\s]+$/, '');
    if (!candidate) return;
    const parsed = emailAddressSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(`“${candidate}” 不是有效的邮箱地址`);
      return;
    }
    if (!value.includes(parsed.data)) onChange([...value, parsed.data]);
    setText('');
    setError(null);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',' || event.key === ';') {
      event.preventDefault();
      addToken(text);
    } else if (event.key === 'Backspace' && text === '' && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  };

  // 粘贴含分隔符的多个地址时一次性解析（如从表格/邮件头复制 "a@x.com, b@y.com"）
  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData('text');
    if (!/[,;\s]/.test(pasted)) return;
    event.preventDefault();
    const parts = pasted.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
    const next = [...value];
    let firstError: string | null = null;
    for (const part of parts) {
      const parsed = emailAddressSchema.safeParse(part);
      if (parsed.success) {
        if (!next.includes(parsed.data)) next.push(parsed.data);
      } else if (!firstError) {
        firstError = `“${part}” 不是有效的邮箱地址`;
      }
    }
    if (next.length !== value.length) onChange(next);
    setError(firstError);
  };

  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          'flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface px-2 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20',
          error && 'border-critical focus-within:border-critical focus-within:ring-critical/20',
        )}
      >
        {value.map((email) => (
          <span
            key={email}
            className="inline-flex items-center gap-1 rounded-sm bg-surface-active px-1.5 py-0.5 text-[13px] text-ink"
          >
            {email}
            <button
              type="button"
              aria-label={`移除 ${email}`}
              onClick={() => onChange(value.filter((item) => item !== email))}
              className="text-ink-tertiary hover:text-ink"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          {...aria}
          aria-invalid={error ? true : aria['aria-invalid']}
          aria-describedby={[aria['aria-describedby'], error ? errorId : undefined].filter(Boolean).join(' ') || undefined}
          value={text}
          list={suggestions && suggestions.length ? listId : undefined}
          placeholder={value.length === 0 ? placeholder : undefined}
          onChange={(event) => {
            setText(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => addToken(text)}
          className="h-6 min-w-40 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-tertiary"
        />
        {suggestions && suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.filter((s) => !value.includes(s)).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
      {error && <p id={errorId} role="alert" className="text-xs text-critical">{error}</p>}
    </div>
  );
}
