import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { claimMailboxRequestSchema, domainSchema, localPartSchema } from '@hpc-mail/shared';
import { ApiError } from '@/api/errors';
import { invalidateMailboxOwnership, queryKeys } from '@/api/query-keys';
import { mailboxApi } from '@/api/resources';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

export interface ClaimDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  domains: string[];
}

export function ClaimDialog({ open, onOpenChange, domains }: ClaimDialogProps) {
  const queryClient = useQueryClient();
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
    onSuccess: () => {
      toast({ title: '地址认领成功', variant: 'success' });
      invalidateMailboxOwnership(queryClient);
      onOpenChange(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : '认领失败，请重试'),
  });

  const reset = () => {
    setLocalPart('');
    setDebounced('');
    setError(null);
  };

  const settled = debounced === localPart && !availability.isFetching;
  const showAvailable = localValid && settled && availability.data?.available === true;
  const showTaken = localValid && settled && availability.data?.available === false;

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
    if (showTaken) {
      setError('该地址已被占用');
      return;
    }
    claim.mutate();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader title="认领邮箱地址" description="认领后即可收发该地址的邮件，并可见其全部历史邮件。" />
        <form onSubmit={handleSubmit}>
          <DialogBody className="flex flex-col gap-4">
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <FormField label="前缀" required error={showTaken ? '该地址已被占用' : undefined}>
                {(field) => (
                  <div className="relative">
                    <Input
                      {...field}
                      placeholder="例如 hello"
                      value={localPart}
                      invalid={showTaken}
                      onChange={(event) => setLocalPart(event.target.value.trim().toLowerCase())}
                    />
                    <span className="absolute right-2.5 top-1/2 -translate-y-1/2">
                      {availability.isFetching && debounced === localPart && localValid && (
                        <Spinner className="size-4 text-ink-tertiary" />
                      )}
                      {showAvailable && <Check className="size-4 text-positive" />}
                      {showTaken && <X className="size-4 text-critical" />}
                    </span>
                  </div>
                )}
              </FormField>
              <div className="flex h-9 items-center pb-[1px] text-sm text-ink-tertiary">@</div>
            </div>
            <FormField label="域名" required>
              {(field) => (
                <Select value={domain} onValueChange={setDomain}>
                  <SelectTrigger id={field.id}>
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
              )}
            </FormField>
            {showAvailable && <p className="text-sm text-positive">{`${localPart}@${domain} 可以认领`}</p>}
            {error && <p role="alert" className="text-sm text-critical">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" loading={claim.isPending} disabled={!localValid || !domainValid || showTaken}>
              认领
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
