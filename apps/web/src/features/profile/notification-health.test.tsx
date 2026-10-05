import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NotificationHealth } from '@hpc-mail/shared';
const mocks = vi.hoisted(() => ({health:vi.fn(),retry:vi.fn(async()=>({success:true})),toast:vi.fn()}));
vi.mock('@/api/resources',()=>({notifyPrefsApi:{health:mocks.health,retry:mocks.retry}}));
vi.mock('@/components/ui/toast',()=>({toast:mocks.toast}));
import { NotificationHealthPanel } from './notification-health';

describe('notification diagnostics',()=>{
  it('shows shared attempt quotas and requires confirmation before retrying an uncertain push',async()=>{
    const timestamp='2026-10-05T00:00:00Z';
    const data:NotificationHealth={channels:[{channel:'feishu',enabled:true,pendingCount:0,failedCount:1,latest:{id:42,messageId:7,target:'',status:'unknown',attempts:1,maxAttempts:3,lastError:'投递结果未确认',lastHttpStatus:502,createdAt:timestamp,updatedAt:timestamp,nextAttemptAt:timestamp,lastAttemptAt:timestamp}},{channel:'forward',enabled:true,pendingCount:0,failedCount:1,latest:{id:43,messageId:7,target:'forward@example.com',status:'failed',attempts:1,maxAttempts:1,lastError:'已达到转发限制',lastHttpStatus:null,createdAt:timestamp,updatedAt:timestamp,nextAttemptAt:timestamp,lastAttemptAt:timestamp}}],forward:{domainLimit:500,targetLimit:200,windowEndsAt:timestamp,domains:[{domain:'mail.example',attempts:499,remaining:1}],targets:[{address:'forward@example.com',attempts:200,remaining:0}]}};
    mocks.health.mockResolvedValue(data);
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
    render(<QueryClientProvider client={client}><NotificationHealthPanel/></QueryClientProvider>);
    await screen.findByText('投递结果未确认');
    expect(screen.getByText('mail.example：尝试 499，剩余 1')).toBeInTheDocument();
    expect(screen.getByText('forward@example.com：尝试 200，剩余 0')).toBeInTheDocument();
    expect(screen.getAllByRole('button',{name:'重试通知'})).toHaveLength(1);
    fireEvent.click(screen.getByRole('button',{name:'重试通知'}));
    expect(screen.getByRole('dialog')).toHaveTextContent('再次推送可能收到重复通知');
    expect(mocks.retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'重新推送'}));
    await waitFor(()=>expect(mocks.retry).toHaveBeenCalledWith(42));
    client.clear();
  });
});
