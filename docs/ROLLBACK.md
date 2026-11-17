# 发布与回滚手册

适用于 `.github/workflows/deploy.yml` 的 GitHub Actions 部署。下文的手动命令都在**仓库根目录**执行，需要 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID` 环境变量（或先 `wrangler login`）。不要在 `apps/worker` 下执行：那里的 `wrangler.toml` 里 D1 id 是占位符，`d1` 命令会解析到占位符而失败。

## 一次发布的顺序

1. 测试、类型检查、构建、依赖审计，注入 Cloudflare 资源配置，`wrangler deploy --dry-run`。
2. **记录回滚基线**：迁移前的 D1 Time Travel 书签、当前承载流量的 Worker 版本 id、当前线上 build（`X-HPC-Build`），写进 Job Summary。
3. 应用 D1 迁移并校验迁移数量；引导管理员与冒烟账号 `ci-smoke`。
4. **发布 Worker**：`wrangler deploy --secrets-file` 把代码和 secrets 发布成同一个版本。
5. 验证新版本：等待 `X-HPC-Build` 等于本次提交 → `scripts/smoke.sh` 冒烟 → 收件金丝雀 → cron 心跳。
6. 第 4、5 步任一失败 → **自动回滚 Worker**。

第 1–3 步失败时新代码还没上线，线上仍是旧版本，不需要回滚；迁移若已执行则保留（见下文「为什么迁移不回滚」）。

## 自动回滚做什么

- 执行 `wrangler rollback <部署前版本 id> -y --message "auto rollback: <run 地址>"`，再轮询 `/api/config` 的 `X-HPC-Build`，确认线上回到部署前的 build。
- Job Summary 的「部署失败：自动回滚」一节列出各验证步骤的结果、回滚目标和是否确认生效。
- 只回滚 Worker 代码与该版本的 secrets 绑定。D1、KV、R2 的数据都不回滚。
- 以下情况不回滚：首次部署（没有旧版本）；线上仍是部署前的版本（发布本身没生效）。
- 回滚后 `main` 上仍是有问题的提交。修复或 `git revert` 后再 push，会重新部署。

## 手动回滚 Worker

自动回滚失败，或者发布成功后才发现问题时：

```bash
npx wrangler deployments status --name hpc-cloud-mail      # 当前线上版本
npx wrangler versions list --name hpc-cloud-mail           # 最近 10 个版本；Message 为 "ci <commit>" 的是 CI 发布的
npx wrangler rollback <版本 id> --name hpc-cloud-mail -y --message "manual rollback: <原因>"
curl -sI https://<CUSTOM_DOMAIN>/api/config | grep -i x-hpc-build   # 确认线上 build
```

要回到某个提交，先在 `versions list` 里按 Message 找到对应版本 id；部署前的版本 id 也记在每次部署的 Job Summary「回滚基线」里。

secrets 按版本绑定：回滚到旧版本，也会用回该版本当时的 `jwt_secret`。如果出问题的那次部署刚轮换了 `JWT_SECRET`，回滚后它签发的会话会失效，用户需要重新登录。

## 为什么迁移不回滚

迁移在新代码上线之前执行，自动回滚只替换 Worker。D1 没有反向迁移；Time Travel 会把整个库倒回到书签时刻，书签之后写入的新邮件、认领、发信记录和会话全部丢失。所以自动流程不碰数据库，迁移必须保证旧代码也能在新 schema 上运行：

- 只做加法：加表、加可空或带默认值的列、加索引。
- 不重命名、不删除仍在使用的列和索引。确需删除时分两次发布：先发不再使用它的代码，稳定后再发删除迁移。
- 不整表重建 `messages`。drizzle 修改列时会生成 `__new_messages` 加拷贝全表，热表上会撞 D1 的执行时限。
- 索引只增不改名。代码里有 `INDEXED BY` 硬编码索引名，索引不存在时整条语句直接报错。

`apps/worker/scripts/check-migrations.mjs` 在测试阶段拦截 `__new_messages`，以及删除仍被 `INDEXED BY` 引用的索引。

## 恢复 D1 数据（Time Travel）

只在数据被写坏、必须倒回时使用。代价是书签之后写入的全部数据。

1. 先把 Worker 回滚到与目标时刻 schema 匹配的版本（通常是该次部署的「部署前线上 Worker 版本」）。否则新代码访问不存在的列会报错。
2. 在 Job Summary「回滚基线」里找到该次部署记录的书签（迁移之前的状态），或者按时间点恢复：

   ```bash
   npx wrangler d1 time-travel restore hpc-cloud-mail-db --bookmark <书签>
   # 或：--timestamp 2026-11-17T08:00:00Z（30 天内）
   ```

   恢复命令会输出恢复前的书签，记下它，需要时可以撤销这次恢复。
3. 书签之后收到的入站邮件，原始信件仍在 R2 的 `raw/<ingestKey>.eml`，需要时可以按原文重新投递补回。附件和超大正文对象不随 D1 回滚，D1 里没有引用的对象会成为孤儿。
4. 恢复后 D1 里迁移记录也倒回了，下次部署会重新执行之后的迁移。

## 冒烟账号与管理员两步验证

- 冒烟账号 `ci-smoke` 是普通用户，由 `apps/worker/scripts/seed-smoke.mjs` 在每次部署前幂等创建。密码由 `JWT_SECRET` 派生，无需另存 secret；轮换 `JWT_SECRET` 后下次部署会自动改密。
- 不要给它认领邮箱，不要把它设为管理员，也不要禁用它：seed 遇到非普通用户或已禁用的 `ci-smoke` 会拒绝覆盖，部署停在发布之前。
- 管理员可以开启两步验证。冒烟脚本收到 `totp_required` 后跳过管理员专属检查（打印 notice），普通用户检查由 `ci-smoke` 完成。
- 站点开启「强制两步验证」后，冒烟只校验未绑定账号被拦截，跳过普通用户的数据接口检查。

本地手动跑冒烟：

```bash
SMOKE_PASSWORD=$(printf '%s' 'ci-smoke-password-v1' | openssl dgst -sha256 -hmac "$JWT_SECRET" -hex | awk '{print $NF}' | cut -c1-32) \
BASE_URL=https://<CUSTOM_DOMAIN> ADMIN_USERNAME=<管理员> ADMIN_PASSWORD=<密码> bash scripts/smoke.sh
```

## 收件金丝雀与 cron 心跳

- 端点只接受 `X-Canary-Token: hex(HMAC-SHA256(jwt_secret, "hpc-canary-v1"))`，令牌错误一律 404：
  - `POST /api/internal/canary` 经 `send_email` 外发一封金丝雀信，从 `canary@A` 发往 `canary@B`（默认取系统域名按字母序的前两个）。
  - `GET /api/internal/canary/<nonce>` 查询是否已收件、由哪个 build 处理。
  - `GET /api/internal/health` 返回当前 build 与 scheduled 最近一次写的心跳。
- 部署时金丝雀须在 3 分钟内由新 build 收件。收件落在旧版本上时补发一次，仍落在旧版本则失败。cron 心跳须在 7 分钟内来自新 build。心跳里有失败步骤只告警，不判失败。
- 可选 GitHub Variables：
  - `DEPLOY_CANARY=off`：跳过金丝雀。Workers Free 计划的 `send_email` 只能发往已验证地址，金丝雀发不出去，需要这样设置。
  - `CANARY_FROM_DOMAIN` / `CANARY_TO_DOMAIN`：指定收发域名，必须在系统域名列表内。
- 系统域名为空（全新部署）时自动跳过金丝雀。
- 金丝雀失败时排查：发件域是否开通 Email Sending；收件域的 Email Routing catch-all 是否指向本 Worker；Worker 日志里 email handler 是否报错。

本地手动探测：

```bash
CANARY_TOKEN=$(printf '%s' 'hpc-canary-v1' | openssl dgst -sha256 -hmac "$JWT_SECRET" -hex | awk '{print $NF}') \
BASE_URL=https://<CUSTOM_DOMAIN> BUILD_SHA=<commit> bash scripts/deploy-probe.sh canary   # 或 heartbeat
```
