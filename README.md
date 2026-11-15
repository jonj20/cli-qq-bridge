# CLI-QQ-Bridge

**CLI-QQ-Bridge** 让一个 QQ 账号（QQ iLink / QQ 机器人）驱动本地 CLI 代理，从普通项目目录操作本地 CLI。它把本地 CLI 保持为主要工作界面，同时让你通过 QQ 远程发送任务、接收结果和状态。

项目是对这个项目的改进：https://github.com/UNLINEARITY/CLI-WeChat-Bridge  
---

## 什么是 CLI-QQ-Bridge

CLI-QQ-Bridge 让一个 QQ 账号驱动本地 CLI 代理，围绕本地工作流设计：**本地终端仍然是主工作界面**，QQ 负责远程输入、结果回流与状态同步。

一个 daemon 运行每个桥；没有单独的独立桥运行时。它有两个用户模式：
- **`qq-daemon`**（居留服务）：首选长连模式。它拥有通道连接，为多个工作区保留 Codex、Claude Code、OpenCode、Pi 插槽，在首个窗口打开前不启动桥接模式。远程打开使用当前窗口的工作区，或在无窗口时使用启动目录（家工作区）。
- **Direct launchers**（直接启动器）：`qq-codex`、`qq-claude`、`qq-opencode`、`qq-pi` 及其 `wecom-*`/`telegram-*`/`telegram-*` 对照，在当前终端运行 CLI。它们加入已运行的 daemon，或在无 daemon 时启动一个临时 daemon（其插槽随窗口，最后一个窗口关闭后退出）；第二个启动器直接加入。

**渐进式桥接模式**：每个桥接从干净的单桥接开始（L0，无前缀，单 CLI 命令），只随窗口打开逐级上扩。在第一个窗口的工作区，另一个 CLI 类型导致多 CLI 模式（L1，`/codex` 等），同一类型到数字化多实例模式（L2，`/1` `/2` `/open`）；L1 和 L2 从不混合。另一个窗口在任意其他工作区会导致无限制多工作区模式（L3，`/cd`）。

运行数据现在默认位于 `~/.cli-bridge`。遗留数据从 `~/.claude/channels/qq` 和 `CLAUDE_QQ_CHANNEL_DATA_DIR` 仅作为迁移源复制迁移。使用 `CLI_BRIDGE_DATA_DIR` 设置活动数据目录。

---

## 支持的 CLI

| 适配器 | 状态 | 说明 |
|--------|------|------|
| Codex | 已验证 | 验证范围 0.149.x 到 0.161.x |
| Claude Code | 最新稳定 | 通过能力探针验证，非版本范围 |
| OpenCode | 最新稳定 | 通过能力探针验证 |
| Pi | 最新稳定 | Pi 0.85 需要 Node.js >= 22.19.0 |

---

## 安装

```bash
npm install -g cli-qq-bridge@latest
```


三个包暴露相同命令；只安装其中一个。切换包名需要先卸载当前包（npm 否则失败并提示 `EEXIST`）。重装提示使用 `getInstalledPackageName()`，因此会命名你实际安装的包。

每次代码构建后，立即全局安装最新构建，让所有者始终测试最新代码：

```bash
npm install -g .
```

当 npm 阻止包 postinstall 脚本时（`allowScripts`），手动恢复 node-pty 生成器权限：

```bash
node "$(npm root -g)/cli-qq-bridge/scripts/ensure-node-pty-permissions.mjs"
```

---

## 快速开始

### 1. 配对 QQ（首选）

```bash
qq-setup
```

按照提示完成 QQ 机器人配对。配对完成后，凭据和操作者身份保存到 `~/.cli-bridge/qq/account.json`。

#### 手动配置方式（扫码绑定）

1. 在 [QQ 开放平台](https://q.qq.com) 创建 QQ 机器人，获取 **AppID** 与 **AppSecret**。
2. 运行 `qq-setup --manual`，输入 AppID 与 AppSecret。
3. 终端会显示二维码，使用手机 QQ 扫码并在 QQ 机器人助手中确认绑定。
4. 如果扫码后门户未返回扫码人 OpenID，或在 `--manual` 模式下，终端会显示一个六位配对码。在 QQ 中向机器人发送 `/pair <六位配对码>` 完成绑定。
5. 配对成功后，凭据与操作者身份保存到 `~/.cli-bridge/qq/account.json`；入站附件保存到 `~/.cli-bridge/qq/inbound-attachments/`。

验证配对是否成功：

```bash
qq-setup --check
```

---

### 2. 在项目目录启动 CLI

```bash
cd /path/to/your/workspace
qq-opencode        # 或 qq-claude、qq-opencode、qq-pi
```

第一个直接启动器若没有运行中的 daemon 会自动启动一个临时 daemon。直接启动器不会替换运行中的 daemon：它们加入它，或在没有 daemon 回答时启动一个临时 daemon。

或先启动居民 daemon：

```bash
qq-daemon  --adapter opencode  # 或 wecom-daemon、telegram-daemon
```

然后在 QQ 聊天窗口发送：

```
/codex
/claude
/opencode
/pi
```

---

## QQ 命令

在 QQ 聊天窗口中，所有以下指令均以 `/` 开头：

| 指令 | 说明 |
|------|------|
| `/status` | 查看桥接/daemon 状态 |
| `/codex [prompt]` | 切换到 Codex；可选 prompt 在切换后转发 |
| `/claude [prompt]` | 切换到 Claude Code；可选 prompt 在切换后转发 |
| `/opencode [prompt]` | 切换到 OpenCode；可选 prompt 在切换后转发 |
| `/pi [prompt]` | 切换到 Pi；可选 prompt 在切换后转发 |
| `/cd` | 切换当前工作区（L3 多目录模式）|
| `/cd <编号或目录名>` | 切换到编号或命名的工作区 |
| `/open` | 在当前目录打开 |
| `/1`、`/2` | 切换到编号实例 1 或 2（L2 模式）|
| `/think on` / `/off` | 开关完整思考/工具调用推送 |
| `/confirm` / `/yes` [n] | 批准工具调用请求 |
| `/always` [n] | 自动允许该工具调用 |
| `/deny` / `/no` [n] [理由] | 拒绝工具调用请求 |
| `/abort` [n] | 中止任务 |
| `/answer` [文本] | 回答等待的用户输入请求 |
| `/model` / `/model <名称>` | 切换模型 |
| `/plan` [on/off] | 切换计划模式 |
| `/all <文本>` | 广播到所有活跃工作区（L3 模式）|
| `/resume` [会话] | 恢复已持久化的会话 |
| `/reset` | 重置当前会话 |
| `/stop` | 中断当前正在运行的任务 |

---

## 关键行为

- **思考输出（流式）**：OpenCode 思考片段按片段流式推送，以 `[思考]` / `[Thinking]` 前缀发送，不再攒到最后一次性吐出；`/think on` 推送全文。
- **工具调用（流式）**：每个 `tool_call` 事件立即发送，不再缓冲，附带工具名和参数；输出顺序与 CLI 实际事件到达顺序一致。
- **会话跟随**：Codex 0.155+ 按需持久化线程；可见客户端默认使用新会话（`new`）。恢复可通过 `--session-start-mode restore`、`/resume`，以及重复使用已连接的可见窗口。
- **daemon 切换**：直接启动器不会替换运行中的 daemon；它们加入它，或者在没有 daemon 时启动一个临时 daemon。过期的 daemon 端点会自动清理。

---

## 开发

```bash
bun install
npm run setup
npm run check
npm run lint
npm run typecheck:src
npm run build
npm run quality
bun test test
```

---

## 包发布

三个包名同构（内容相同）：`cli-qq-bridge`。

```bash
npm run publish:dual -- --dry-run
npm run publish:dual -- --otp <code>
```

---

## 许可证

本仓库使用 AGPL-3.0-or-later。每个源文件开头必须保留 SPDX 版权声明；在新文件和修改中不要删除或篡改。任何贡献者或 AI 代理做出的、后来被分发或通过网络服务的修改，必须根据 AGPL-3.0-or-later 公开完整对应源代码（见 README 许可证部分）。

另见 `LICENSE.txt`。

---

## 文档

- `docs/releases/<version>.md` — 发行说明
- `docs/releases/<version>_CN.md` — 中文发行说明
- `docs/architecture.md` — 架构概述
- `docs/development.md` — 开发命令
- `docs/configuration.md` — 配置
- `docs/command-audit.md` — 命令审计

---

## 提交指导

所有提交需要先得到所有者明确批准。使用常规提交前缀，如 `feat:`、`fix:`、`refactor:`、`docs:`、`test:`、`build:`、`chore:`。保持标语为祈使句、行为导向。

---

## 质量检查

```bash
npm run lint
npm run typecheck:src
bun test test
npm run build
npm run quality
```

---

*内部计划、审计和研究文档仅供本地使用，绝不得暂存、提交、推送或打包。*
