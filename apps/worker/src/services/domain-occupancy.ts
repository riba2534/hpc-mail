/**
 * 同一域名不能同时是系统域名和用户托管域名。
 *
 * 系统域名存放在 settings 的 JSON 里，托管域名存放在 hosted_domains 表里，靠事先查询无法互斥：
 * 两个请求可以同时查过对方，再各自写入。所以每个写入点都把对方的检查写进自己那条写语句的 WHERE。
 * D1 按顺序执行写入，单条语句的检查和写入是原子的，先执行的一方生效，后执行的一方写不进去。
 */

/**
 * 判断参数 `param`（如 `?1`）对应的域名是否在系统域名列表中。
 * 判定方式与认领语句一致（mailbox.ts），同时兼容旧版存为纯字符串的条目。
 */
export const systemDomainListedSql = (param: string): string => `EXISTS (SELECT 1 FROM settings,
  json_each(settings.value, '$.list') AS configured
  WHERE settings.key = 'domains' AND lower(trim(CASE WHEN configured.type = 'text' THEN configured.value
    ELSE json_extract(configured.value, '$.domain') END)) = ${param})`;

/** 判断参数 `param` 所绑定的 JSON 域名数组中，是否有域名已被用户托管 */
export const anyHostedSql = (param: string): string =>
  `EXISTS (SELECT 1 FROM hosted_domains WHERE domain IN (SELECT value FROM json_each(${param})))`;

/**
 * 系统域名接入任务的终态。进行中的任务（state 不是终态）参与同名互斥，
 * 表达式与部分唯一索引 uniq_system_onboarding_active_domain 的 WHERE 一致，规划器才能用上该索引。
 */
export const ONBOARDING_TERMINAL_SQL = "('completed', 'cancelled', 'failed')";

/** 参数 `param` 对应的域名有进行中的系统域名接入任务 */
export const onboardingActiveSql = (param: string): string => `EXISTS (SELECT 1 FROM system_domain_onboarding
  WHERE domain = ${param} AND state NOT IN ${ONBOARDING_TERMINAL_SQL})`;

/** 参数 `param` 所绑定的 JSON 域名数组中，是否有域名正在作为系统域名接入 */
export const anyOnboardingSql = (param: string): string => `EXISTS (SELECT 1 FROM system_domain_onboarding
  WHERE domain IN (SELECT value FROM json_each(${param})) AND state NOT IN ${ONBOARDING_TERMINAL_SQL})`;

/** 参数 `param` 对应的域名已被用户托管（任意状态，含删除中） */
export const hostedTakenSql = (param: string): string => `EXISTS (SELECT 1 FROM hosted_domains WHERE domain = ${param})`;

/** 系统域名列表现有条数 */
export const SYSTEM_DOMAIN_COUNT_SQL = "COALESCE((SELECT json_array_length(value, '$.list') FROM settings WHERE key = 'domains'), 0)";

/** 进行中的接入任务数：与系统列表条数相加不超过列表上限，接入完成时一定能写进列表 */
export const ACTIVE_ONBOARDING_COUNT_SQL = `(SELECT COUNT(*) FROM system_domain_onboarding WHERE state NOT IN ${ONBOARDING_TERMINAL_SQL})`;

/**
 * 站长账户里等待 NS 的 zone 数：托管的 pending 域名加上系统接入新建、尚未激活的 zone，合计不超过
 * hosted_domains.maxPendingTotal。站长账户在 zone 超过 50 个且 pending 多于 active 时不能再新增 zone，两类功能共用这份额度。
 */
export const PENDING_ZONES_TOTAL_SQL = `((SELECT COUNT(*) FROM hosted_domains WHERE status = 'pending')
  + (SELECT COUNT(*) FROM system_domain_onboarding WHERE mode = 'new_zone' AND state IN ('creating_zone', 'awaiting_ns')))`;

/** 设置里的 hosted_domains.maxPendingTotal；没有该设置行时取参数 `fallback`（绑定默认值） */
export const maxPendingTotalSql = (fallback: string): string =>
  `COALESCE((SELECT json_extract(value, '$.maxPendingTotal') FROM settings WHERE key = 'hosted_domains'), ${fallback})`;
