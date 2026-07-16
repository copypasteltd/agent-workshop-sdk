# 灵办词元 Runtime Bridge / Lingban Runtime Bridge

Runtime Bridge 运行在每个用户 Run 的隔离执行环境中，直接托管 Codex CLI PTY 会话，并把对话、审批、文件、MCP、凭证、状态和诊断连接到平台后端。

The Runtime Bridge runs inside each isolated user run environment. It hosts the Codex CLI PTY session and connects conversations, approvals, files, MCP servers, credentials, status, and diagnostics to the platform backend.

## 仓库信息 / Repository

| 项目 | 内容 |
| --- | --- |
| GitHub | `git@github.com:copypasteltd/agent-workshop-sdk.git` |
| Monorepo 路径 | `app/container-bridge` |
| 主分支 | `main` |
| Runtime | Node.js 22、TypeScript、node-pty、chokidar、Zod |
| 进程角色 | 每个 Run 一个 Bridge 实例 |
| 控制面 | Local HTTP + Backend internal API |

仓库沿用 `agent-workshop-sdk` 名称，当前交付内容为 Runtime Bridge。Standalone export 会带齐 `config/contracts/mcp/shared` 依赖。

The repository retains the `agent-workshop-sdk` name and currently ships the runtime bridge plus its internal dependency closure.

## 主要职责 / Responsibilities

- 启动、监控、重启和关闭 Codex CLI PTY 会话。
- 将用户消息、审批、取消和控制命令写入 Codex 会话。
- 解析 stdout/stderr 并生成结构化 Bridge Event。
- 监听 target path 与 outputs，回传文件变更和 Artifact。
- 物化第一方及第三方 MCP，支持本地进程与远程协议。
- 通过 Secret Manifest 将凭证注入环境变量或受控文件。
- 代理远程 MCP 请求并执行网络策略、认证和审计。
- 向 API 注册、刷新心跳、批量回传事件、同步状态与诊断。
- 暴露本地 health、control、diagnostics 与 metrics 接口。

## 工程结构 / Code Structure

| 路径 | 职责 |
| --- | --- |
| `src/cli.ts` | Runtime 入口、配置装载、组件装配与生命周期 |
| `src/bridge/codex-session.ts` | PTY、输入队列、退出检测、自愈重启与历史回放 |
| `src/bridge/event-parser.ts` | stdout/stderr 事件解析 |
| `src/bridge/file-watcher.ts` | target path 文件扫描与增量变更 |
| `src/bridge/artifact-publisher.ts` | Artifact 缓冲、批量回传和诊断 |
| `src/bridge/mcp-materializer.ts` | MCP 模式选择、路径校验与配置落盘 |
| `src/bridge/mcp-call-audit-watcher.ts` | MCP 调用日志读取与事件化 |
| `src/bridge/remote-mcp-proxy-server.ts` | HTTP/SSE/WebSocket MCP 代理和出网校验 |
| `src/bridge/secret-loader.ts` | Secret 引用解析和注入 |
| `src/bridge/run-control-server.ts` | 消息、审批、取消、同步和刷新控制 |
| `src/transports/api-connector.ts` | 注册、心跳、事件、状态、Artifact 与凭证回调 |
| `src/transports/control-http.ts` | 本地 HTTP 路由、Token 鉴权和指标 |
| `src/runtime-egress-firewall.ts` | Runtime 出网规则应用与诊断 |
| `src/observability.ts` | Bridge 诊断模型和 Prometheus 指标 |

## MCP 模式 / MCP Modes

| 模式 | 适用对象 | 控制 |
| --- | --- | --- |
| `local-process` | stdio MCP | 可执行路径前缀、摘要、参数与环境白名单 |
| `remote-managed` | 平台管理的 HTTP/SSE/WebSocket MCP | 本地代理、凭证注入、网络策略与审计 |
| `remote-unmanaged` | 用户接入的外部 MCP | 每请求目标校验、受控 Header、超时与调用审计 |

第三方 MCP 的网络目标在连接建立和请求转发阶段均执行策略检查。WebSocket upgrade 与 SSE 长连接使用同一套目标验证。

Third-party MCP targets are validated both when the connection is created and when requests are forwarded, including WebSocket upgrades and SSE streams.

## 控制接口 / Control Surface

| Endpoint | 作用 |
| --- | --- |
| `GET /health` | Bridge 存活状态 |
| `GET /diagnostics` | PTY、文件、Artifact、MCP 与回调诊断 |
| `GET /metrics` | Prometheus 指标 |
| `POST /control` | `sendMessage`, `approve`, `cancel`, `ping`, `syncFiles`, `flushArtifacts` |

控制接口使用 `LINGBAN_BRIDGE_CONTROL_TOKEN`。Bridge 到 Backend 的内部请求使用 `LINGBAN_INTERNAL_AUTH_TOKEN` 与幂等键。

## 配置 / Configuration

```env
BRIDGE_CONTEXT_PATH=/workspace/runtime/bridge-context.container.json
RUNTIME_CONFIG_PATH=/workspace/runtime/runtime-config.json
RUNTIME_DIR=/workspace/runtime
OUTPUTS_PATH=/workspace/outputs
LINGBAN_API_BASE_URL=http://127.0.0.1:3100
LINGBAN_INTERNAL_AUTH_TOKEN=<long-random-secret>
LINGBAN_BRIDGE_CONTROL_TOKEN=<run-scoped-secret>
CODEX_BIN=codex
CODEX_ARGS_JSON=[]
```

Provider Base URL、API Key 与模型通过 Run Worker 解析后的 Run-scoped 环境注入。Bridge 不持久化明文平台凭证。

Provider base URLs, API keys, and models are injected as run-scoped environment values resolved by the worker. The bridge does not persist plaintext platform credentials.

## 开发与验证 / Development

```bash
pnpm -C app/container-bridge typecheck
pnpm -C app/container-bridge build
pnpm -C app/container-bridge test
pnpm -C app/container-bridge start:runtime
```

测试覆盖 API Connector、CLI 事件转发、恢复、控制面鉴权与观测、MCP 物化、远程 MCP 代理和 Egress Firewall。原生测试通过依赖注入验证 Runtime 行为。

Tests cover the API connector, CLI event forwarding, recovery, control-plane authentication and observability, MCP materialization, remote MCP proxying, and egress firewall behavior.

## App Server Session / App Server Session

Production session control uses `codex app-server --listen stdio://` through `src/bridge/app-server-session.ts`.

| Capability | Implementation |
|---|---|
| Startup | `initialize` → `thread/start` → `turn/start` |
| Continued conversation | Reuses one Thread across multiple Turns |
| Active-turn input | `turn/steer` with `expectedTurnId` |
| Structured input | `item/tool/requestUserInput` response mapping |
| Approval | Structured approval request and result |
| Evidence | Every JSON-RPC request, response, and notification is emitted as a hashed raw event |
| Ordering | Thread and Turn IDs are extracted before raw-event emission |
| Compatibility | `CODEX_RUNTIME_PROTOCOL=legacy-pty` remains available for controlled rollback |

## 当前状态 / Current Status

截至 2026-07-17，Bridge 已实现 Codex App Server 主链、PTY 兼容回滚、异常恢复、输入回放、文件与 Artifact 回流、三类 MCP 物化、远程代理、Secret 注入、内部 API 接线和完整诊断面。

As of 2026-07-17, the bridge uses Codex App Server as the primary structured protocol and retains a controlled PTY rollback adapter. Recovery, MCP materialization, secret injection, API integration, and runtime diagnostics remain available.

最新原生测试结果：25/25 通过。

Latest native test result: 25/25 passed.

生产深化项包括长时会话压力测试、Codex CLI 多版本兼容矩阵、第三方 MCP 故障注入、Run-scoped 密钥轮换和断网恢复演练。

Production hardening covers long-running session load tests, a Codex CLI version matrix, third-party MCP fault injection, run-scoped secret rotation, and network interruption recovery drills.
