import type { Mailbox } from '@hpc-mail/shared';
import { useMemo } from 'react';
import { Combobox } from '@/components/ui/combobox';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { compareText, sortedTexts } from '@/lib/sort';

export interface IdentityPickerProps {
  isAdmin: boolean;
  mailboxes: Mailbox[];
  /** 自定义前缀可选的域名：管理员为系统域名加自己的托管域名，普通用户只有自己的托管域名 */
  domains: string[];
  /** 自己作为所有者、发信就绪的托管域名；普通用户有它才出现自定义前缀 */
  hostedDomains?: string[];
  mailboxId: number | null;
  onMailboxId: (id: number | null) => void;
  localPart: string;
  onLocalPart: (value: string) => void;
  domain: string;
  onDomain: (value: string) => void;
  /** 发件身份的字段级错误；触发器 id 固定，便于提交失败时聚焦 */
  error?: string;
  id?: string;
}

const CUSTOM = 'custom';

export function IdentityPicker({
  isAdmin,
  mailboxes,
  domains,
  hostedDomains = [],
  mailboxId,
  onMailboxId,
  localPart,
  onLocalPart,
  domain,
  onDomain,
  error,
  id,
}: IdentityPickerProps) {
  // 下拉一律按地址/域名字典序，可搜索
  const mailboxOptions = useMemo(
    () => [...mailboxes].sort((a, b) => compareText(a.address, b.address)).map((mailbox) => ({ value: String(mailbox.id), label: mailbox.address })),
    [mailboxes],
  );
  const domainOptions = useMemo(() => sortedTexts(domains).map((item) => ({ value: item, label: item })), [domains]);

  if (isAdmin || hostedDomains.length > 0) {
    const custom = mailboxId === null;
    // 普通用户的自定义前缀只来自托管域名，服务端发出时把地址认领给所有者；管理员发信不认领
    const customLabel = isAdmin ? '自定义发件地址' : hostedDomains.length === 1 ? `用 ${hostedDomains[0]} 的任意前缀发信` : '用托管域名的任意前缀发信';
    const customHint = !isAdmin
      ? hostedDomains.includes(domain) ? `用 ${domain} 的任意前缀发信（发出时自动认领）` : '选择你托管的域名，前缀可任意填写（发出时自动认领）'
      : hostedDomains.length > 0 ? '管理员可用任意前缀 + 系统域名或自己托管的域名发件。' : '管理员可用任意前缀 + 系统域名发件。';
    return (
      <div className="flex flex-col gap-3">
      <FormField
        label="发件身份"
        htmlFor={id}
        error={custom ? undefined : error}
        description={isAdmin ? '可选择已有邮箱（含保留的旧域邮箱），或填写系统域名下的地址。' : '可选择已认领的邮箱，或用自己托管的域名的任意前缀发信。'}
      >
        {(field) => (
          <Combobox
            {...field}
            invalid={!custom && Boolean(error)}
            value={mailboxId ? String(mailboxId) : CUSTOM}
            onChange={(value) => { if (value) onMailboxId(value === CUSTOM ? null : Number(value)); }}
            options={[{ value: CUSTOM, label: customLabel }, ...mailboxOptions]}
            clearable={false}
            searchPlaceholder="搜索邮箱地址…"
            emptyText="没有匹配的邮箱"
          />
        )}
      </FormField>
      {custom && <FormField label="发件地址" htmlFor={id && `${id}-local`} description={customHint} error={error} required>
        {(field) => (
          <div className="flex items-center gap-2">
            <Input
              id={field.id}
              aria-describedby={field['aria-describedby']}
              invalid={Boolean(error)}
              placeholder="前缀"
              value={localPart}
              onChange={(event) => onLocalPart(event.target.value.trim().toLowerCase())}
              className="flex-1"
            />
            <span className="text-sm text-ink-tertiary">@</span>
            <div className="w-48">
              <Combobox
                aria-label="发件域名"
                value={domain || null}
                onChange={(value) => { if (value) onDomain(value); }}
                options={domainOptions}
                clearable={false}
                placeholder="域名"
                searchPlaceholder="搜索域名…"
                emptyText="没有匹配的域名"
              />
            </div>
          </div>
        )}
      </FormField>}
      </div>
    );
  }

  return (
    <FormField label="发件地址" htmlFor={id} error={error} required>
      {(field) => (
        <Combobox
          {...field}
          invalid={Boolean(error)}
          value={mailboxId ? String(mailboxId) : null}
          onChange={(value) => { if (value) onMailboxId(Number(value)); }}
          options={mailboxOptions}
          clearable={false}
          placeholder={mailboxes.length === 0 ? '请先认领一个地址' : '选择发件地址'}
          searchPlaceholder="搜索邮箱地址…"
          emptyText={mailboxes.length === 0 ? '还没有认领的地址' : '没有匹配的邮箱'}
        />
      )}
    </FormField>
  );
}
