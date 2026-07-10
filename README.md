# 灵办词元 Runtime SDK / Lingban Runtime SDK

## 概览 / Overview

本仓库承载灵办词元的运行时 bridge 层。它运行在独立进程或容器内，负责连接 Codex CLI、物化 MCP 与凭证、监听文件变化、发布 artifact、接受控制命令，并可将事件回传给 API。

This repository hosts the Lingban runtime bridge layer. It runs inside a dedicated process or container, connects to Codex CLI, materializes MCP bindings and secrets, watches files, publishes artifacts, accepts control commands, and can report events back to the API.

## 当前职责 / Responsibilities

- 管理 Codex PTY 会话
- 解析 stdout / stderr 为结构化事件
- 监听 target path 与 outputs 变化
- 发布 artifact 事件
- 物化 MCP 配置
- 物化凭证 env / file
- 提供本地控制 HTTP
- 通过 internal API 向后端注册与回传事件
- 在注册 payload 中携带外部可达 control URL，并周期性 refresh register

- Manage the Codex PTY session
- Parse stdout / stderr into structured events
- Watch target-path and outputs changes
- Publish artifact events
- Materialize MCP configuration
- Materialize secrets as env vars or files
- Expose a local control HTTP endpoint
- Register with the backend and send events through the internal API
- Carry the externally reachable control URL in bridge registration and periodically refresh the registration

## 技术栈 / Tech Stack

- TypeScript
- node-pty
- chokidar
- Zod
- Workspace-shared package:
  - `@lingban/contracts`

## 目录结构 / Directory Structure

```text
src/
  bridge/
    codex-session.ts
    event-parser.ts
    file-watcher.ts
    artifact-publisher.ts
    mcp-materializer.ts
    secret-loader.ts
    run-control-server.ts
  transports/
    control-http.ts
    api-connector.ts
  cli.ts
  index.ts
```

## 开发命令 / Scripts

```bash
pnpm build
pnpm typecheck
pnpm start:runtime
```

## 运行模式 / Runtime Modes

- Embedded mode: imported and launched inside the API process for local development
- Managed process mode: launched as an independent process by the worker
- Container mode: prepared for runner-image execution through the generated runtime files

## 状态 / Status

当前仓库已经具备 PTY 管理、文件监听、artifact 发现、MCP/secret 物化、本地控制接口、internal API 回传，以及 bridge register 刷新能力。后续将继续补强真实容器网络控制、生产观测与自愈能力。

The repository already supports PTY management, file watching, artifact discovery, MCP/secret materialization, a local control endpoint, internal API callbacks, and periodic bridge-registration refresh. The next steps are stronger container-network control, production observability, and self-healing.
