# 灵办词元 Runtime Bridge / Lingban Runtime Bridge

## 仓库定位 / Repository Role

本目录是灵办词元的运行桥接层，位于 `app/container-bridge`。它直接托管 Codex CLI 会话，并把文件、事件、MCP、凭证与控制指令接到平台后端。

This directory contains the Lingban runtime bridge at `app/container-bridge`. It directly hosts the Codex CLI session and wires files, events, MCP, credentials, and control commands back into the platform backend.

## 主要职责 / Responsibilities

- 启动与管理 Codex CLI PTY 会话
- 解析 stdout / stderr 为结构化事件
- 监听 target path 与输出目录变化
- 发布 artifact、文件、诊断与状态事件
- 物化 MCP 配置与第三方凭证
- 暴露本地控制 HTTP，接入 backend internal API

## 代码结构 / Code Structure

| 路径 | 作用 | 关键文件 |
| --- | --- | --- |
| `src/bridge/codex-session.ts` | Codex PTY 生命周期管理 | `codex-session.ts` |
| `src/bridge/event-parser.ts` | stdout / stderr 事件解析 | `event-parser.ts` |
| `src/bridge/file-watcher.ts` | 文件监听与变更捕获 | `file-watcher.ts` |
| `src/bridge/artifact-publisher.ts` | 产物发布与回写 | `artifact-publisher.ts` |
| `src/bridge/mcp-materializer.ts` | MCP 配置落地 | `mcp-materializer.ts` |
| `src/bridge/mcp-call-audit-watcher.ts` | MCP 调用审计监听 | `mcp-call-audit-watcher.ts` |
| `src/bridge/remote-mcp-proxy-server.ts` | 远端 MCP 代理接线 | `remote-mcp-proxy-server.ts` |
| `src/bridge/secret-loader.ts` | secret 注入与文件物化 | `secret-loader.ts` |
| `src/bridge/run-control-server.ts` | 本地运行控制接口 | `run-control-server.ts` |
| `src/transports/api-connector.ts` | 与 API 的 internal 通信 | `api-connector.ts` |
| `src/transports/control-http.ts` | 对外控制 HTTP 适配 | `control-http.ts` |
| `src/runtime-egress-firewall.ts` | 运行时出网限制 | `runtime-egress-firewall.ts` |
| `src/observability.ts` | 日志与观测 | `observability.ts` |

## 运行模式 / Runtime Modes

| 模式 | 说明 |
| --- | --- |
| Embedded | 本地调试时由上层直接引入 |
| Managed Process | 由 run-worker 启动独立进程 |
| Container Runtime | 使用 runtime 物料在隔离环境中运行 |

## 开发命令 / Commands

```bash
pnpm -C app/container-bridge build
pnpm -C app/container-bridge typecheck
pnpm -C app/container-bridge start:runtime
pnpm -C app/container-bridge test
```

## 当前状态 / Current Status

当前 bridge 已具备 PTY 管理、文件监听、artifact 发布、MCP/secret 物化、控制面接线与 internal callback 回传能力。后续重点是更严格的网络治理、远端 MCP 代理强化与故障恢复机制。
