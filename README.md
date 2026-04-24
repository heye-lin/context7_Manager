# Context7 号池网关

一个面向个人 Context7 Key 管理的号池网关，包含 Node.js 后端 API 和原生 HTML/CSS/JS 管理后台。项目负责加密保存 Context7 Key、维护账号健康状态、支持单账号测试并记录自动获取到的账号剩余额度。

## 功能

- 管理后台使用 `ADMIN_TOKEN` 鉴权。
- 网关调用使用独立 `GATEWAY_TOKEN` 鉴权。
- Context7 Key 使用 AES-256-GCM 加密后持久化。
- 账号列表只返回脱敏后的 `tokenPreview`，不返回明文 Key。
- 账号池管理页支持新增、启停、删除、搜索和筛选账号。
- 每个账号卡片提供“账号测试”按钮，使用该账号请求 Context7，并从 `RateLimit-Remaining` / `X-RateLimit-Remaining` 响应头自动更新剩余额度。
- `/healthz` 和 `/readyz` 用于健康检查。
- 支持内存仓库和 JSON 文件仓库；生产建议配置 `ACCOUNT_STORE_PATH`。

## 前置条件

- Node.js `>=20`
- npm
- 可选：Docker 和 Docker Compose

## 配置

复制环境变量示例：

```powershell
Copy-Item .env.example .env
```

至少设置以下变量：

```text
PORT=3000
ADMIN_TOKEN=replace-with-a-long-random-admin-token
GATEWAY_TOKEN=replace-with-a-long-random-gateway-token
ENCRYPTION_KEY=replace-with-a-long-random-encryption-secret
CONTEXT7_BASE_URL=https://context7.com
CONTEXT7_MCP_URL=https://mcp.context7.com/mcp
ACCOUNT_STORE_PATH=data/accounts.json
AUDIT_LOG_PATH=data/audit-logs.json
```

变量说明：

- `PORT`：HTTP 服务端口，默认 `3000`。
- `ADMIN_TOKEN`：访问管理后台和管理 API 的令牌。
- `GATEWAY_TOKEN`：外部调用网关 API 的令牌。
- `ENCRYPTION_KEY`：加密本地 Context7 Key 的密钥；更换后旧数据可能无法解密。
- `CONTEXT7_BASE_URL`：Context7 上游地址。
- `CONTEXT7_MCP_URL`：Context7 官方 MCP 远程节点地址，默认 `https://mcp.context7.com/mcp`。
- `ACCOUNT_STORE_PATH`：加密账号数据 JSON 文件路径。

不要提交真实 `.env`、Context7 API Key、`ADMIN_TOKEN`、`GATEWAY_TOKEN` 或 `ENCRYPTION_KEY`。

## 本地运行

首次运行前请先复制 `.env.example` 并配置强随机密钥，避免使用开发默认值。

```bash
npm install
npm start
```

访问：

```text
http://localhost:3000
```

打开页面后输入 `ADMIN_TOKEN` 登录。账号测试功能在“账号池管理”页面的每个账号卡片上，不再提供独立的网关调试页面。

## Docker 运行

```bash
docker compose --env-file .env up --build
```

后台运行：

```bash
docker compose --env-file .env up -d --build
```

Compose 会把加密账号数据保存到持久化 volume。请定期备份该 volume 或 `ACCOUNT_STORE_PATH` 指向的数据文件。

注意：Compose 默认只持久化 `/app/data`。如果在容器内通过安全设置页写入 `.env`，容器重建后这些 `.env` 变更可能丢失；生产建议以宿主机 `.env` / Compose 环境变量作为配置来源。

## 测试

```bash
npm test
```

## API

### Public

- `GET /healthz`：进程健康检查。
- `GET /readyz`：依赖就绪检查。

### Admin Protected

请求头：

```text
Authorization: Bearer <ADMIN_TOKEN>
```

- `GET /api/session`：验证后台登录状态。
- `GET /api/settings`：查看服务端 `.env` 配置摘要。
- `PATCH /api/settings`：更新服务端 `.env` 配置。
- `GET /api/accounts`：查看账号列表。
- `POST /api/accounts`：新增账号，参数 `{ "name": "主号", "token": "ctx7sk-..." }`。
- `PATCH /api/accounts/:id`：更新账号名称、Key、启停状态或剩余额度。
- `DELETE /api/accounts/:id`：删除账号。
- `POST /api/accounts/:id/test`：使用指定账号测试 Context7，并自动回写调用统计和剩余额度。
- `POST /api/leases`：获取一个可用账号和完整 Token，主要用于受控自检。
- `POST /api/accounts/:id/usage`：记录调用结果。

账号测试请求体示例：

```json
{
  "method": "GET",
  "path": "/api/v2/libs/search?query=react"
}
```

字段说明：

- `method`：可选，默认 `GET`。
- `path`：可选，默认 `/api/v2/libs/search?query=react`。
- `body`：可选，非 `GET` / `DELETE` 请求时会作为 JSON 请求体发送。

响应包含：`account`、`success`、`statusCode`、`durationMs`、`upstream`。如果上游返回 `RateLimit-Remaining` 或 `X-RateLimit-Remaining`，服务端会自动更新该账号的 `remainingQuota`。

### Gateway Protected

请求头：

```text
Authorization: Bearer <GATEWAY_TOKEN>
```

- `POST /api/gateway`：通过号池代理调用 Context7 上游。该接口保留给程序调用，后台不再提供独立调试页面。
- `POST /mcp`：透明转发到 Context7 官方 MCP 节点，服务端从账号池轮询 Context7 Key，并向上游注入 `CONTEXT7_API_KEY: <pooled Context7 Key>` 请求头。

示例：

```bash
curl -X POST http://localhost:3000/api/gateway \
  -H "Authorization: Bearer <GATEWAY_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"method":"GET","path":"/api/v2/libs/search?query=react"}'
```

MCP 客户端可把远程地址配置为你的网关，而不是直接配置官方节点：

```toml
[mcp_servers.context7]
url = "http://localhost:3000/mcp"

[mcp_servers.context7.headers]
Authorization = "Bearer <GATEWAY_TOKEN>"
```

如果部署到服务器：

```toml
[mcp_servers.context7]
url = "https://your-domain.com/mcp"

[mcp_servers.context7.headers]
Authorization = "Bearer <GATEWAY_TOKEN>"
```

客户端请求 `/mcp` 时必须通过你的网关鉴权层，必须携带：

```text
Authorization: Bearer <GATEWAY_TOKEN>
```

`/mcp` 不实现 MCP tools，只做透明代理：请求体原样转发，官方响应原样返回，同时更新账号使用次数、失败次数和剩余额度。
客户端只向你的网关发送 `Authorization: Bearer <GATEWAY_TOKEN>`；不要把 Context7 API Key 配到 MCP 客户端。客户端的 `Authorization` 不会透传给官方 MCP 节点，官方节点只会收到服务端注入的 `CONTEXT7_API_KEY`。代理响应会额外带 `x-context7-account-id` 和 `x-context7-account-name`，方便排查本次请求使用了哪个账号。

## 生产安全

- 生产必须配置高强度 `ADMIN_TOKEN`、`GATEWAY_TOKEN` 和 `ENCRYPTION_KEY`。
- 生产必须让 `GATEWAY_TOKEN` 与 `ADMIN_TOKEN` 不同；未配置 `GATEWAY_TOKEN` 时服务端会回退使用 `ADMIN_TOKEN`。
- 管理后台建议放在 HTTPS 和受控网络之后。
- 浏览器端会把 `ADMIN_TOKEN` 保存到 `localStorage`，请只在可信设备上使用后台。
- `POST /api/leases` 会返回完整 Context7 Key，只应在可信管理端用于受控自检。
- `ACCOUNT_STORE_PATH` 保存的是加密数据，但仍应按敏感数据限制访问和备份。
- 更换 `ENCRYPTION_KEY` 前请先备份账号数据。
- 如果登录后账号加载失败，优先检查 `ENCRYPTION_KEY` 是否与旧数据匹配。

## 调用日志

- 控制台“调用日志”页面用于查看整个系统日志，包括登录会话、`/api/gateway`、`/mcp`、账号管理、账号测试、配置变更、租号自检、版本更新和系统错误。
- 服务端新增 `GET /api/logs` 管理接口，使用 `ADMIN_TOKEN` 鉴权，支持 `limit`、`type`、`success`、`accountId` 查询参数。
- 配置 `AUDIT_LOG_PATH=data/audit-logs.json` 后日志会持久化保存；不配置时使用内存日志，服务重启后清空。
- 日志只保存账号 ID、账号名、事件类型、动作、路径、状态码、耗时和成功状态，不保存 Context7 Key 明文或密文。

## 控制台退出与版本更新

- 后台侧边栏提供“退出登录”，会清理浏览器中的 `ADMIN_TOKEN` 并返回 token 拦截登录页。
- 安全设置页新增“版本更新”，参考 sub2api 的动态更新流程：单个“检查并更新”按钮会先检查 GitHub Release 最新版本，有新版本时再执行更新操作；没有新版本时不会请求更新接口。
- 系统更新接口为 `GET /api/system/version`、`GET /api/system/check-updates` 和 `POST /api/system/update`，均使用 `ADMIN_TOKEN` 鉴权。
- 当前项目默认是 `source` 构建类型，不再执行在线 `git pull`；如发现新版本，请通过 CI/CD、Release 包或手动部署更新，完成后重启服务。
- 该设计避免在生产运行进程中直接修改工作区代码，也避免覆盖线上临时文件。

## Release Commands

Pushing to `main` automatically publishes the `latest` GHCR image and creates a prerelease named like `v0.1.0-build.123`. Run one of the commands below when you want a formal semver Release tag.

```bash
npm run release:patch  # 0.1.0 -> 0.1.1
npm run release:minor  # 0.1.0 -> 0.2.0
npm run release:major  # 0.1.0 -> 1.0.0
```

After the release workflow finishes, update the remote server:

```bash
docker compose -f docker-compose.prod.yml --env-file .env pull
docker compose -f docker-compose.prod.yml --env-file .env up -d
```


## License

This project is released under the MIT License. See `LICENSE` for details.

## Disclaimer

This project is an open-source personal Context7 key pool gateway and management console. It is not affiliated with, endorsed by, or sponsored by Context7.

Use this software at your own risk. You are responsible for complying with Context7 terms, API limits, local laws, and any policies that apply to your account or deployment environment.

Do not expose admin tokens, gateway tokens, Context7 keys, encryption keys, logs, or persisted data files publicly. The authors and contributors are not responsible for account suspension, quota loss, data loss, security incidents, service interruption, or any direct or indirect damages caused by deploying or using this software.
