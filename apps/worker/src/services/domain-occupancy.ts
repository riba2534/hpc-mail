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
