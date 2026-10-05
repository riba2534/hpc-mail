import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(() => ({claim:vi.fn(async () => ({})),availability:vi.fn(async () => ({available:true})),toast:vi.fn()}));
vi.mock('@/api/resources',() => ({mailboxApi:{claim:mocks.claim,availability:mocks.availability}}));
vi.mock('@/components/ui/toast',() => ({toast:mocks.toast}));
import { ClaimDialog } from './claim-dialog';
vi.stubGlobal('ResizeObserver',class {observe() {} unobserve() {} disconnect() {}});
describe('claim selected domain retention', () => {
  it('chooses an available domain when the previous selection is removed',async () => {
    const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
    const wrap=(domains:string[]) => <QueryClientProvider client={client}><ClaimDialog open={true} onOpenChange={vi.fn()} domains={domains} /></QueryClientProvider>;
    const view=render(wrap(['old.example','new.example']));
    fireEvent.change(screen.getByPlaceholderText('例如 hello'),{target:{value:'test'}});
    view.rerender(wrap(['new.example']));
    fireEvent.click(screen.getByRole('button',{name:'认领'}));
    await waitFor(() => expect(mocks.claim).toHaveBeenCalledWith({localPart:'test',domain:'new.example'}));
    client.clear();
  });
});
