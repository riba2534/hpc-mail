import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Shuffle, X } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { claimMailboxRequestSchema, domainSchema, localPartSchema } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { mailboxApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { writeClipboard } from '@/components/ui/copy-button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { randomLocalPart, unavailableMessage } from './claim-helpers';

export interface ClaimDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domains: string[];
}

function announceClaimed(address: string) {
  toast({
    title: '地址认领成功',
    description: address,
    variant: 'success',
    action: {
      label: '复制地址',
      onClick: () =>
        void writeClipboard(address).then((ok) =>
          toast(ok ? { title: '已复制到剪贴板', variant: 'success' } : { title: '复制失败，请手动选择', variant: 'error' }),
        ),
    },
  });
}

export function ClaimDialog({ open, onOpenChange, domains }: ClaimDialogProps) {
  const queryClient = useQueryClient();
  const inputId = useId();
  const statusId = `${inputId}-status`;
  const [localPart, setLocalPart] = useState('');
  const [domain, setDomain] = useState(domains[0] ?? '');
  const [debounced, setDebounced] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!domains.includes(domain)) setDomain(domains[0] ?? '');
  }, [open, domain, domains]);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => setDebounced(localPart), 400);
    return () => globalThis.clearTimeout(timer);
  }, [localPart]);

  const localValid = localPartSchema.safeParse(localPart).success;
  const domainValid = domains.includes(domain) && domainSchema.safeParse(domain).success;

  const availability = useQuery({
    queryKey: queryKeys.mailboxes.availability(debounced, domain),
    queryFn: () => mailboxApi.availability(debounced, domain),
    enabled: open && localValid && domainValid && debounced.length > 0 && debounced === localPart,
  });

  const claim = useMutation({
    mutationFn: () => mailboxApi.claim({ localPart, domain }),
    onSuccess: (created) => {
      announceClaimed(created?.address ?? `${localPart}@${domain}`);
      invalidateMailboxOwnership(queryClient);
      onOpenChange(false);
      reset();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '认领失败，请重试'),
  });

  function reset() {
    setLocalPart('');
    setDebounced('');
    setError(null);
  }

  const changeLocalPart = (value: string) => {
    setLocalPart(value);
    setError(null);
  };

  const randomize = () => {
    const next = randomLocalPart();
    changeLocalPart(next);
    // 随机值无需等防抖，立即查可用性
    setDebounced(next);
  };

  const settled = debounced === localPart && !availability.isFetching;
  const checking = localValid && debounced === localPart && availability.isFetching;
  const showAvailable = localValid && settled && availability.data?.available === true;
  const unavailable = localValid && settled && availability.data ? unavailableMessage(availability.data) : null;
  const formatError = localPart.length > 0 && !localValid ? localPartSchema.safeParse(localPart).error?.issues[0]?.message : null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!domainValid) {
      setError('可用域名已变更，请重新选择');
      return;
    }
    const parsed = claimMailboxRequestSchema.safeParse({ localPart, domain });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '请检查输入');
      return;
    }
    if (unavailable) {
      setError(unavailable);
      return;
    }
    claim.mutate();
  };

  const statusText = formatError ?? unavailable ?? (showAvailable ? `${localPart}@${domain} 可以认领` : null);
  const statusTone = formatError || unavailable ? 'text-critical' : showAvailable ? 'text-positive' : 'text-ink-tertiary';

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader title="认领邮箱地址" description="认领后即可收发该地址的邮件，并可见其全部历史邮件。" />
        <form onSubmit={handleSubmit}>
          <DialogBody className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor={inputId} className="text-sm font-medium text-ink">
                  邮箱地址
                  <span className="ml-0.5 text-critical">*</span>
                </label>
                <Button type="button" variant="ghost" size="sm" className="-mr-2" onClick={randomize}>
                  <Shuffle className="size-4" />
                  随机生成
                </Button>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                <div className="relative">
                  <Input
                    id={inputId}
                    aria-label="前缀"
                    aria-describedby={statusText ? statusId : undefined}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="例如 hello"
                    value={localPart}
                    invalid={Boolean(formatError || unavailable)}
                    className="pr-8"
                    onChange={(event) => changeLocalPart(event.target.value.trim().toLowerCase())}
                  />
                  <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">
                    {checking && <Spinner className="size-4 text-ink-tertiary" />}
                    {showAvailable && <Check className="size-4 text-positive" />}
                    {unavailable && <X className="size-4 text-critical" />}
                  </span>
                </div>
                <span className="text-sm text-ink-tertiary" aria-hidden>
                  @
                </span>
                <Select value={domain} onValueChange={setDomain}>
                  <SelectTrigger aria-label="域名">
                    <SelectValue placeholder="选择域名" />
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
              <p id={statusId} role="status" aria-live="polite" className={cn('min-h-5 text-xs', statusTone)}>
                {statusText ?? (checking ? '正在检查是否可认领…' : '')}
              </p>
            </div>
            {error && error !== unavailable && (
              <p role="alert" className="text-sm text-critical">
                {error}
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" loading={claim.isPending} disabled={!localValid || !domainValid || unavailable !== null}>
              认领
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
