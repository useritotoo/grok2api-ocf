# Grok2API Cloudflare Worker

这个目录是当前仓库的独立 Cloudflare Worker 子工程，专门用于：

- 保留主仓库根目录的 Python/FastAPI 结构，降低 fork `sync fork` 时的冲突面
- 让 Cloudflare Dashboard 直接从 GitHub 导入并部署 `cloudflare-worker/`
- 在首次部署时自动创建并绑定 D1、KV，并在部署流程里导入初始化表结构与基础配置

## 为什么放在子目录

Cloudflare Worker 的代码、`wrangler.toml`、迁移文件、静态资源同步脚本都集中在这里。上游主仓库继续更新根目录 Python 版本时，只要 Cloudflare Dashboard 的 `Root directory` 仍指向 `cloudflare-worker`，就不会因为根目录结构变化而破坏 Worker 部署。

## 目录说明

- `src/`: Worker 运行时代码
- `migrations/`: D1 迁移
- `scripts/sync-assets.mjs`: 将主仓库 `../_public/static` 同步到 Worker 的 `./.assets`
- `wrangler.toml`: Worker 配置，保留 D1/KV 绑定定义但不写死实际 ID

## Cloudflare Dashboard 部署

在 Cloudflare Dashboard 连接 GitHub 后，导入这个仓库时建议这样设置：

1. `Root directory`: `cloudflare-worker`
2. `Build command`: `npm run build`
3. `Deploy command`: `npm run deploy`
4. `Version command`: `npm run deploy:upload`

这样在 Connected Builds 里会执行：

1. 同步主仓库静态资源到 `cloudflare-worker/.assets`
2. 做 TypeScript 类型检查
3. `wrangler deploy`

部署链路里故意不再追加 `wrangler d1 migrations apply DB --remote`。因为 Cloudflare Dashboard 自动 provision 的 D1 绑定在构建环境里没有写回仓库内的 `database_id`，强行在 deploy 命令里跑远程 migration 会让整次构建在发布成功后反而失败。

D1 表结构和初始化配置改为由 Worker 运行时自动补齐：首次请求进入 Worker 时会执行 `ensureDbSchema`，定时任务执行时也会再次确保基础表结构存在。

## 首次部署默认内容

首次请求或定时任务触发初始化后，D1 内会自动写入当前主线管理页需要的配置分区，例如：

- `app`
- `proxy`
- `retry`
- `token`
- `cache`
- `chat`
- `image`
- `imagine_fast`
- `video`
- `voice`
- `asset`
- `nsfw`
- `usage`

其中默认基础值包含：

- `app.app_key = "admin"`
- `app.api_key = ""`
- `app.function_enabled = false`
- `app.function_key = ""`

因此首次部署完成后，管理后台可以直接用 `admin` 登录。

## 绑定策略

`wrangler.toml` 里保留了：

- `[[d1_databases]] binding = "DB"`
- `[[kv_namespaces]] binding = "KV_CACHE"`
- `assets = { directory = "./.assets", binding = "ASSETS" }`

但不把实际 `database_id`、`id` 写死到仓库里，目的是：

- 让 Cloudflare 在首次 Dashboard 部署时创建并接管资源
- 避免 fork 到不同账号后还要先改死的资源 ID
- 减少和上游同步时的无意义冲突

## 本地验证

```bash
npm install
npm test
npm run typecheck
npm run sync-assets
```

如果要本地手动发布：

```bash
npm run deploy:local
```

## 运行说明

- 当前 Worker 页面资源来自主仓库 `../_public/static`
- Worker 适配的是当前主线前端协议，不再沿用旧版 `keys/datacenter/chat_admin` 页面
- `function` 任务态已落到 D1，避免 Cloudflare isolate 切换后直接丢失
- `/v1/responses` 与 `/v1/videos` 走的是当前 Worker 已有 `/chat/completions` 能力的适配层
