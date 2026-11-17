# 发布与回滚手册

适用于 `.github/workflows/deploy.yml` 的 GitHub Actions 部署。下文的手动命令都在 **`apps/worker` 目录**用 `pnpm exec wrangler` 执行（仓库锁定的 wrangler 版本，不会像 `npx` 那样去拉最新版；先在仓库根目录 `pnpm install`），需要 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 环境变量（或先 `pnpm exec wrangler login`）。

`apps/worker/wrangler.toml` 里的 D1 id 是占位符：`d1` 命令要加 `--cwd "$(mktemp -d)"`，让 wrangler 不读这份配置、按库名向 Cloudflare 查真实 id。

## 一次发布的顺序

1. 测试、类型检查、构建、依赖审计，注入 Cloudflare 资源配置，`wrangler deploy --dry-run`。设置了 Variable `DELIVERY_EVENTS_QUEUE`（启用外发投递回执）时，注入配置后还会只读预检 Token 的 Queues 权限，缺权限在这里失败。
2. **记录回滚基线**：迁移前的 D1 Time Travel 书签、当前承载流量的 Worker 版本 id、当前线上 build（`X-HPC-Build`），写进 Job Summary。
3. 应用 D1 迁移并校验迁移数量；引导管理员与冒烟账号 `ci-smoke`。
4. **发布 Worker**：启用了投递回执时先确保 Queue 存在（失败即中止，线上仍是旧版本）；`wrangler deploy --secrets-file` 把代码和 secrets 发布成同一个版本。
5. 验证新版本：等待 `X-HPC-Build` 等于本次提交 → `scripts/smoke.sh` 冒烟 → 收件金丝雀 → cron 心跳。
6. 第 4、5 步任一失败，或运行在发布之后被取消 → **自动回滚 Worker**。

第 1–3 步失败时新代码还没上线，线上仍是旧版本，不需要回滚；迁移若已执行则保留（见下文「为什么迁移不回滚」）。

## 自动回滚做什么

- 执行 `wrangler rollback <部署前版本 id> -y --message "auto rollback: <run 地址>"`，再轮询 `/api/config` 的 `X-HPC-Build`，确认线上回到部署前的 build。
- Job Summary 的「部署失败或被取消：自动回滚」一节列出各验证步骤的结果、回滚目标和是否确认生效。
- 发布之后的每个步骤都有单步超时，请求也都有单次超时：线上挂住时步骤以失败结束，回滚仍有时间执行。
- 只回滚 Worker 代码与该版本的 secrets 绑定。D1、KV、R2 的数据都不回滚。
- 以下情况不回滚：首次部署（没有旧版本）；线上仍是部署前的版本（发布本身没生效）。
- 回滚后 `main` 上仍是有问题的提交。修复或 `git revert` 后再 push，会重新部署。

## 手动回滚 Worker

自动回滚失败，或者发布成功后才发现问题时：

```bash
cd apps/worker
pnpm exec wrangler deployments status --name hpc-cloud-mail      # 当前线上版本
pnpm exec wrangler versions list --name hpc-cloud-mail           # 最近 10 个版本；Message 为 "ci <commit>" 的是 CI 发布的
pnpm exec wrangler rollback <版本 id> --name hpc-cloud-mail -y --message "manual rollback: <原因>"
curl -sI https://<CUSTOM_DOMAIN>/api/config | grep -i x-hpc-build   # 确认线上 build
```

要回到某个提交，先在 `versions list` 里按 Message 找到对应版本 id；部署前的版本 id 也记在每次部署的 Job Summary「回滚基线」里。

secrets 按版本绑定：回滚到旧版本，也会用回该版本当时的 `jwt_secret`。如果出问题的那次部署刚轮换了 `JWT_SECRET`，回滚后它签发的会话会失效，用户需要重新登录。

## 为什么迁移不回滚

迁移在新代码上线之前执行，自动回滚只替换 Worker。D1 没有反向迁移；Time Travel 会把整个库倒回到书签时刻，书签之后写入的新邮件、认领、发信记录和会话全部丢失。所以自动流程不碰数据库，迁移必须保证旧代码也能在新 schema 上运行：

- 只做加法：加表、加可空或带默认值的列、加索引。
- 不删表、不删列、不改表名和列名。确需删除时分两次发布：先发不再使用它的代码，稳定后再发删除迁移。
- 不整表重建。drizzle 修改列时会生成 `__new_<表>` 加拷贝全表，热表上会撞 D1 的执行时限。
- 索引只增不改名。代码里有 `INDEXED BY` 硬编码索引名，索引不存在时整条语句直接报错。

`apps/worker/scripts/check-migrations.mjs` 在测试阶段按 SQL 词法检查迁移（已上线的 0000–0020 按完整文件名白名单豁免，其他文件一律检查），拦截 `DROP TABLE`、`ALTER TABLE … DROP COLUMN` / `RENAME COLUMN` / `RENAME TO`、`__new_` 整表重建，以及删除仍被 `INDEXED BY` 引用的索引。分两次发布的第二次（删除确已无人使用的表或列）在迁移文件里写一行 `-- migration-check: allow <原因>` 豁免，测试输出会列出所有豁免。

## 恢复 D1 数据（Time Travel）

只在数据被写坏、必须倒回时使用。代价是书签之后写入的全部数据。

1. 先把 Worker 回滚到与目标时刻 schema 匹配的版本（通常是该次部署的「部署前线上 Worker 版本」）。否则新代码访问不存在的列会报错。
2. 在 Job Summary「回滚基线」里找到该次部署记录的书签（迁移之前的状态），或者按时间点恢复：

   ```bash
   cd apps/worker
   pnpm exec wrangler d1 time-travel restore hpc-cloud-mail-db --bookmark <书签> --cwd "$(mktemp -d)"
   # 或：--timestamp 2026-11-17T08:00:00Z（30 天内）
   ```

   恢复命令会输出恢复前的书签，记下它，需要时可以撤销这次恢复。
3. 书签之后收到的入站邮件，原始信件仍在 R2 的 `raw/<ingestKey>.eml`，需要时可以按原文重新投递补回。附件和超大正文对象不随 D1 回滚，D1 里没有引用的对象会成为孤儿。
4. 恢复后 D1 里迁移记录也倒回了，下次部署会重新执行之后的迁移。

## 冒烟账号与管理员两步验证

- 冒烟账号 `ci-smoke` 是普通用户，由 `apps/worker/scripts/seed-smoke.mjs` 在每次部署前幂等创建。密码由 `JWT_SECRET` 派生，无需另存 secret；轮换 `JWT_SECRET` 后下次部署会自动改密。
- `ci-smoke` 是系统保留用户名，注册和管理员创建都不能使用，`ADMIN_USERNAME` 也不能用它。
- 不要给它认领邮箱、创建 API Key、添加托管域名、开两步验证、设为管理员或禁用：seed 遇到这样的 `ci-smoke` 会拒绝覆盖、不改密码，部署停在发布之前，按报错提示处理该账号即可。
- 别人共享给 `ci-smoke` 的邮箱不会卡住部署：seed 每次自动撤销这些共享并打印条数（任何用户都能共享给它，冒烟账号不应看到任何邮件）。
- 冒烟账号登录失败判冒烟失败（触发回滚）。管理员登录不了只跳过管理员专属检查、不判失败：
  - 管理员开了两步验证：配置可选 Secret `ADMIN_TOTP_SECRET`（管理员 TOTP 种子，base32）后，冒烟按它算出当前验证码登录，管理员检查照常执行；没配置时打印 notice 跳过。
  - 返回 `bad_credentials`（站长在网页改了密码而 CI 的 `ADMIN_PASSWORD` 没跟上，或种子不对）：打印 warning 跳过，请尽快同步 secret。
- 站点开启「强制两步验证」后，冒烟只校验未绑定账号被拦截，跳过普通用户的数据接口检查。

本地手动跑冒烟：

```bash
SMOKE_PASSWORD=$(printf '%s' 'ci-smoke-password-v1' | openssl dgst -sha256 -hmac "$JWT_SECRET" -hex | awk '{print $NF}' | cut -c1-32) \
BASE_URL=https://<CUSTOM_DOMAIN> ADMIN_USERNAME=<管理员> ADMIN_PASSWORD=<密码> bash scripts/smoke.sh
# 管理员开了两步验证时可再加 ADMIN_TOTP_SECRET=<种子>（需要 node）
```

## 收件金丝雀与 cron 心跳

- 端点只接受 `X-Canary-Token: hex(HMAC-SHA256(jwt_secret, "hpc-canary-v1"))`，令牌错误一律 404：
  - `POST /api/internal/canary` 经 `send_email` 外发一封金丝雀信，从 `canary@A` 发往 `canary@B`（默认取系统域名按字母序的前两个）。
  - `GET /api/internal/canary/<nonce>` 查询是否已收件、由哪个 build 处理。
  - `GET /api/internal/health` 返回当前 build 与 scheduled 最近一次写的心跳。
- **金丝雀默认不执行**（会真实外发邮件）。启用方式（GitHub Variables）：
  - 同时设置 `CANARY_FROM_DOMAIN` 与 `CANARY_TO_DOMAIN`：发件与收件域名，必须都在系统域名列表内，收件域要已配好 Email Routing catch-all。推荐这种。
  - 或设置 `DEPLOY_CANARY=on`：由服务端取系统域名按字母序的前两个。
  - `DEPLOY_CANARY=off` 一律跳过。Workers Free 计划的 `send_email` 只能发往已验证地址，金丝雀发不出去，不要启用。
- 启用后金丝雀须在 3 分钟内由新 build 收件。外发遇到网络错误或 5xx 重试一次；收件落在旧版本上时补发一次（全站每分钟 2 封的额度没被重试用掉时），仍落在旧版本则失败。
- cron 心跳默认检查：10 分钟内心跳的 build 须等于本次提交。只比对 build，不看心跳时间：同一提交重跑部署时心跳不会刷新，看到的是上一次的心跳。心跳里有失败步骤只告警，不判失败。
- 金丝雀失败时排查：发件域是否开通 Email Sending；收件域的 Email Routing catch-all 是否指向本 Worker；Worker 日志里 email handler 是否报错。

本地手动探测：

```bash
CANARY_TOKEN=$(printf '%s' 'hpc-canary-v1' | openssl dgst -sha256 -hmac "$JWT_SECRET" -hex | awk '{print $NF}') \
BASE_URL=https://<CUSTOM_DOMAIN> BUILD_SHA=<commit> DEPLOY_CANARY=on bash scripts/deploy-probe.sh canary   # 或 heartbeat
```
