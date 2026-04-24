# Context7 号池网关

一个面向生产基线的 Context7 号池网关，包含 Node.js 后端 API 和原生 HTML/CSS/JS 管理后台。后端负责保存、加密、调度 Context7 API Key，并通过网关接口代理调用 Context7 上游。

## 生产基线能力

- 管理后台使用 `ADMIN_TOKEN` 鉴权
- 网关 API 使用独立 `GATEWAY_TOKEN` 鉴权
- Context7 Key AES-256-GCM 加密后存储
- 账号列表只返回脱敏 `tokenPreview`
- 网关代理自动注入 `Authorization: Bearer <Context7 Key>`
- 成功/失败自动回写账号健康统计
- 网关调用审计事件，不保存明文 token
- `/healthz` 和 `/readyz` 健康检查
- Dockerfile、docker-compose 和 `.env.example`
- 可选 JSON 文件持久化，重启后恢复加密账号

> 当前支持内存仓储和 JSON 文件仓储。高并发或多实例生产部署建议下一步替换为 PostgreSQL/SQLite repository。

## 配置

复制环境变量示例：

```powershell
Copy-Item .env.example .env
```

必须设置在项目根目录 `.env` 中；服务会读取 `G:\1-demo\context7_Manager\.env`，并在请求时检测变更，`ADMIN_TOKEN` / `GATEWAY_TOKEN` 修改后无需重启即可生效：

```powershell
$env:ADMIN_TOKEN="替换为长随机管理令牌"
$env:GATEWAY_TOKEN="替换为长随机网关调用令牌"
$env:ENCRYPTION_KEY="替换为长随机加密密钥"
$env:CONTEXT7_BASE_URL="https://context7.com"
$env:ACCOUNT_STORE_PATH="data/accounts.json"
```

也可以直接编辑 `.env`：

```text
ADMIN_TOKEN=管理后台长随机令牌
GATEWAY_TOKEN=网关调用长随机令牌
ENCRYPTION_KEY=加密长随机密钥
CONTEXT7_BASE_URL=https://context7.com
ACCOUNT_STORE_PATH=data/accounts.json
```

不要把真实 Context7 API Key 写入代码、README 或提交到仓库。请通过管理后台新增账号。

## 本地运行

```bash
npm start
```

启动后访问：

```text
http://localhost:3000
```

打开页面后必须先输入 `ADMIN_TOKEN`。未验证时页面会停留在登录页，不会加载账号池数据。网关调试区另行填写 `GATEWAY_TOKEN`，用于调用 `/api/gateway`。

## Docker 运行

```bash
docker compose up --build
```

Compose 会把加密后的账号数据保存到 `context7-data` volume。

## 测试

```bash
npm test
```

## API

### Public

- `GET /healthz`：进程健康检查
- `GET /readyz`：依赖就绪检查

### Admin Protected

以下接口需要请求头：

```text
Authorization: Bearer <ADMIN_TOKEN>
```

- `GET /api/session`：验证管理后台登录态
- `GET /api/accounts`：查看账号列表，只返回脱敏后的 `tokenPreview`
- `POST /api/accounts`：新增账号，参数 `{ "name": "主号", "token": "ctx7sk-..." }`
- `PATCH /api/accounts/:id`：更新名称、Token 或启停状态
- `DELETE /api/accounts/:id`：删除账号
- `POST /api/leases`：获取一个可用账号和完整 Token，主要用于受控调试
- `POST /api/accounts/:id/usage`：记录调用结果

### Gateway Protected

网关调用接口使用独立令牌：

```text
Authorization: Bearer <GATEWAY_TOKEN>
```

- `POST /api/gateway`：通过号池代理调用 Context7 上游

### 网关调用示例

```json
{
  "method": "GET",
  "path": "/api/v2/libs/search?query=react"
}
```

## 下一步生产增强

- 替换 JSON 文件 repository 为 PostgreSQL/SQLite 持久化
- 面向个人账户增加调用方 API Key 和限流，不做租户隔离
- 增加连续失败熔断、冷却期和自动恢复探测
- 输出结构化 JSON 日志和 Prometheus 指标
- 后台增加调用日志查询、账号配额和健康仪表盘
- 安全设置页已支持可视化管理 `.env` 中的 token、上游地址和存储路径
