#!/usr/bin/env node
// BIC challenges scripting clients before they can reach API authentication.
// Keep every other Cloudflare security product enabled; scope this exception to API paths.
const token = process.env.CLOUDFLARE_API_TOKEN;
const hostname = process.env.CUSTOM_DOMAIN;
if (!token || !hostname || !/^[a-z0-9.-]+$/.test(hostname)) throw new Error('CLOUDFLARE_API_TOKEN and CUSTOM_DOMAIN are required');
async function cf(path, method = 'GET', body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000),
  });
  const data = await response.json();
  if (!data.success) throw new Error(`Cloudflare API failed (${response.status}): ${JSON.stringify(data.errors)}`);
  return data.result;
}
const zones = await cf(`/zones?name=${encodeURIComponent(hostname)}`);
if (zones.length !== 1) throw new Error('Expected one exact hostname zone; configure subdomain zones explicitly');
const base = `/zones/${zones[0].id}`;
const sets = await cf(`${base}/rulesets`);
const existing = sets.find(set => set.phase === 'http_request_firewall_custom' && set.kind === 'zone');
const rule = {
  ref: 'hpc_mail_api_bic_exception', description: 'HPC Mail API scripting clients: skip only Browser Integrity Check',
  expression: `(http.host eq "${hostname}" and (starts_with(http.request.uri.path, "/api/") or starts_with(http.request.uri.path, "/v1/")))`,
  action: 'skip', action_parameters: { products: ['bic'] }, logging: { enabled: true }, enabled: true,
};
if (existing) {
  const set = await cf(`${base}/rulesets/${existing.id}`);
  const oldRule = set.rules.find(item => item.ref === rule.ref);
  if (oldRule) await cf(`${base}/rulesets/${existing.id}/rules/${oldRule.id}`, 'PATCH', rule);
  else await cf(`${base}/rulesets/${existing.id}/rules`, 'POST', rule);
} else {
  await cf(`${base}/rulesets`, 'POST', { name: 'HPC Mail API compatibility', kind: 'zone', phase: 'http_request_firewall_custom', rules: [rule] });
}
console.log('API-only Browser Integrity Check exception configured; other Cloudflare rules preserved.');
