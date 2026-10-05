import type { Mailbox } from '@hpc-mail/shared';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface IdentityPickerProps {
  isAdmin: boolean;
  mailboxes: Mailbox[];
  domains: string[];
  mailboxId: number | null;
  onMailboxId: (id: number | null) => void;
  localPart: string;
  onLocalPart: (value: string) => void;
  domain: string;
  onDomain: (value: string) => void;
}

export function IdentityPicker({
  isAdmin,
  mailboxes,
  domains,
  mailboxId,
  onMailboxId,
  localPart,
  onLocalPart,
  domain,
  onDomain,
}: IdentityPickerProps) {
  if (isAdmin) {
    return (
      <div className="flex flex-col gap-3">
      <FormField label="发件身份" description="可选择已有邮箱（含保留的旧域邮箱），或填写系统域名下的地址。">
        {(field) => (
          <Select value={mailboxId ? String(mailboxId) : 'custom'} onValueChange={(value) => { if (value) onMailboxId(value === 'custom' ? null : Number(value)); }}>
            <SelectTrigger {...field}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="custom">自定义发件地址</SelectItem>
              {mailboxes.map((mailbox) => <SelectItem key={mailbox.id} value={String(mailbox.id)}>{mailbox.address}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
      </FormField>
      {mailboxId === null && <FormField label="发件地址" description="管理员可用任意前缀 + 系统域名发件。" required>
        {(field) => (
          <div className="flex items-center gap-2">
            <Input
              id={field.id}
              placeholder="前缀"
              value={localPart}
              onChange={(event) => onLocalPart(event.target.value.trim().toLowerCase())}
              className="flex-1"
            />
            <span className="text-sm text-ink-tertiary">@</span>
            <div className="w-48">
              <Select value={domain} onValueChange={onDomain}>
                <SelectTrigger aria-label="发件域名">
                  <SelectValue placeholder="域名" />
                </SelectTrigger>
                <SelectContent>
                  {domains.map((item) => (
                    <SelectItem key={item} value={item}>
                      {item}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </FormField>}
      </div>
    );
  }

  return (
    <FormField label="发件地址" required>
      {(field) => (
        <Select
          value={mailboxId ? String(mailboxId) : ''}
          onValueChange={(value) => { if (value) onMailboxId(Number(value)); }}
        >
          <SelectTrigger id={field.id}>
            <SelectValue placeholder={mailboxes.length === 0 ? '请先认领一个地址' : '选择发件地址'} />
          </SelectTrigger>
          <SelectContent>
            {mailboxes.map((mailbox) => (
              <SelectItem key={mailbox.id} value={String(mailbox.id)}>
                {mailbox.address}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FormField>
  );
}
