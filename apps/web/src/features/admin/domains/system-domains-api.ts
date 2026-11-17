import { type QueryClient, useQuery } from '@tanstack/react-query';
import type {
  CancelSystemDomainOnboardingRequest,
  ConfirmSystemDomainOnboardingRequest,
  CreateSystemDomainOnboardingRequest,
  SystemDomainHiddenZones,
  SystemDomainOnboarding,
  SystemDomainOnboardingState,
  SystemDomainOnboardingSummary,
  SystemDomainPrecheck,
  SystemDomainPrecheckQuery,
  SystemDomainZonesView,
  UpdateSystemDomainHiddenZonesRequest,
} from '@hpc-mail/shared';
import { api } from '@/api/client';

/** 系统域名一键接入的缓存键：只在收件域名页 chunk 里用到，不放进入口 chunk 的 query-keys.ts */
export const systemDomainKeys = {
  zonesRoot: ['admin', 'system-domain-zones'] as const,
  zones: (hidden: boolean) => ['admin', 'system-domain-zones', hidden] as const,
  onboarding: (id: number) => ['admin', 'system-domain-onboarding', id] as const,
};

/** 预检、接入与检测会同步调用 Cloudflare，给足时间 */
const CF_TIMEOUT_MS = 60_000;
const BASE = '/admin/system-domains';

/** 系统域名一键接入的接口只在收件域名页（同一个懒加载 chunk）用到，不放进入口 chunk 里的 api/resources.ts */
export const systemDomainApi = {
  zones: (hidden: boolean, refresh = false) =>
    api.get<SystemDomainZonesView>(`${BASE}/zones`, {
      query: { hidden: hidden ? '1' : '0', ...(refresh ? { refresh: '1' } : {}) },
      timeoutMs: CF_TIMEOUT_MS,
    }),
  precheck: (query: SystemDomainPrecheckQuery) =>
    api.get<SystemDomainPrecheck>(`${BASE}/precheck`, { query: { ...query }, timeoutMs: CF_TIMEOUT_MS }),
  create: (body: CreateSystemDomainOnboardingRequest) =>
    api.post<SystemDomainOnboarding, CreateSystemDomainOnboardingRequest>(`${BASE}/onboardings`, body, { timeoutMs: CF_TIMEOUT_MS }),
  list: (active: boolean) => api.get<SystemDomainOnboarding[]>(`${BASE}/onboardings`, { query: { active: active ? '1' : '0' } }),
  get: (id: number) => api.get<SystemDomainOnboarding>(`${BASE}/onboardings/${id}`),
  check: (id: number) => api.post<SystemDomainOnboarding>(`${BASE}/onboardings/${id}/check`, undefined, { timeoutMs: CF_TIMEOUT_MS }),
  confirm: (id: number, body: ConfirmSystemDomainOnboardingRequest) =>
    api.post<SystemDomainOnboarding, ConfirmSystemDomainOnboardingRequest>(`${BASE}/onboardings/${id}/confirm`, body, { timeoutMs: CF_TIMEOUT_MS }),
  cancel: (id: number, body: CancelSystemDomainOnboardingRequest) =>
    api.post<SystemDomainOnboarding, CancelSystemDomainOnboardingRequest>(`${BASE}/onboardings/${id}/cancel`, body, { timeoutMs: CF_TIMEOUT_MS }),
  setHidden: (body: UpdateSystemDomainHiddenZonesRequest) =>
    api.put<SystemDomainHiddenZones, UpdateSystemDomainHiddenZonesRequest>(`${BASE}/hidden-zones`, body),
};

/** 行内进度轮询：写入中每 5 秒，等待 NS 或阻断时每 30 秒，其余（待确认、终态）不轮询 */
export const FAST_POLL_MS = 5_000;
export const SLOW_POLL_MS = 30_000;
const FAST_STATES: readonly SystemDomainOnboardingState[] = ['creating_zone', 'configuring', 'finalizing', 'cancelling'];
const SLOW_STATES: readonly SystemDomainOnboardingState[] = ['awaiting_ns', 'blocked'];

export function pollIntervalFor(states: readonly SystemDomainOnboardingState[]): number | false {
  if (states.some((state) => FAST_STATES.includes(state))) return FAST_POLL_MS;
  if (states.some((state) => SLOW_STATES.includes(state))) return SLOW_POLL_MS;
  return false;
}

/** 视图里所有进行中任务的状态 */
export function activeStatesOf(view: SystemDomainZonesView | undefined): SystemDomainOnboardingState[] {
  if (!view) return [];
  const tasks: SystemDomainOnboardingSummary[] = [
    ...view.zones.flatMap((zone) => (zone.onboarding ? [zone.onboarding] : [])),
    ...view.unlistedTasks,
  ];
  return tasks.map((task) => task.state);
}

export function useSystemDomainZones(hidden: boolean) {
  return useQuery({
    queryKey: systemDomainKeys.zones(hidden),
    queryFn: () => systemDomainApi.zones(hidden),
    staleTime: 30_000,
    retry: false,
    refetchInterval: (query) => pollIntervalFor(activeStatesOf(query.state.data)),
  });
}

export function useSystemDomainOnboarding(id: number) {
  return useQuery({
    queryKey: systemDomainKeys.onboarding(id),
    queryFn: () => systemDomainApi.get(id),
    enabled: Number.isInteger(id) && id > 0,
    retry: false,
    refetchInterval: (query) => (query.state.data ? pollIntervalFor([query.state.data.state]) : false),
  });
}

const summaryOf = (task: SystemDomainOnboarding): SystemDomainOnboardingSummary => ({
  id: task.id, domain: task.domain, mode: task.mode, state: task.state, steps: task.steps, errorCode: task.errorCode,
  lastError: task.lastError, updatedAt: task.updatedAt, nextCheckAt: task.nextCheckAt, cancelRequested: task.cancelRequested,
});

/** 写操作返回的最新任务：就地更新详情与可接入列表里对应的行（终态的行由轮询刷新时移走） */
export function storeOnboarding(client: QueryClient, task: SystemDomainOnboarding): void {
  client.setQueryData(systemDomainKeys.onboarding(task.id), task);
  const summary = summaryOf(task);
  client.setQueriesData<SystemDomainZonesView>({ queryKey: systemDomainKeys.zonesRoot }, (view) => {
    if (!view) return view;
    const zones = view.zones.map((zone) => (zone.onboarding?.id === task.id || (task.zoneId !== null && zone.zoneId === task.zoneId)
      ? { ...zone, category: 'onboarding' as const, onboarding: summary }
      : zone));
    const listed = zones.some((zone) => zone.onboarding?.id === task.id);
    const unlistedTasks = listed ? view.unlistedTasks.filter((item) => item.id !== task.id)
      : [...view.unlistedTasks.filter((item) => item.id !== task.id), summary];
    return { ...view, zones, unlistedTasks };
  });
}
