# OpenCode V2 Metrics Plugin

OpenCode V2 Desktop 指标插件，在输入框上方显示速度、首包延迟和缓存命中率。

## 显示内容

药丸固定三段，缺数据时显示 `—`，布局不会跳动：

```text
实时 125 tok/s · 首包 3.32s · 缓存 5.4%
平均 96 tok/s · 到达 1.24s · 缓存 97.9%
等待首字 · 首包 — · 缓存 —
```

| 场景 | 速度段 | 数据来源 |
| --- | --- | --- |
| 正在生成 | `实时 128 tok/s` | 本步从模型调用开始到现在的估算速度 |
| 生成刚开始 | `等待首字` | 还没收到任何 chunk |
| 一轮结束 | `平均 96 tok/s` | 本会话所有已完成步骤的加权平均 |
| 只有一步且失败 | `上次 84 tok/s` | 上一步的实际速度 |
| 没有数据 | `速度 —` | 会话内还没有可用指标 |

第二段按数据源自动切换标签：

- `首包 X` —— HTTP 响应体第一个字节，最接近网络真实延迟；
- `到达 X` —— 首字时间（含排队与模型启动），首包拿不到时自动降级。

悬停可看到：平均/上次速度、含思考耗时、网络首包/平均首包/首字、输入与缓存读 token、已完成步数、模型。

## 口径说明

- **实时速度**：`tokens / (step 开始 → 现在)`，包含首包等待和思考时间。模型思考得慢，这个数就低——这是有意为之。
- **平均速度**：`所有已完成步骤的 tokens / 所有已完成步骤的墙钟时间`，同样包含思考。
- **首包延迟**：HTTP 请求发出到响应体第一个字节。
- **缓存命中率**：`cacheRead / (input + cacheRead)`，按会话累计，优先使用 provider 报告的精确值。
- **空闲判定**：一步在没有结束事件的情况下静默超过 45 秒，按空闲处理并切回「平均」，避免被打断的回合一直显示「实时」。
- **请求过滤**：只统计 `kind === "primary"` 的请求。标题生成、压缩、临时生成等辅助请求不会抢走首包计时。

## 重要限制

这是 **Desktop GUI 插件**。指标栏显示在 OpenCode Desktop 的 Composer 状态区域，不会显示在纯 TUI/CLI 窗口中。

## 安装

解压后在本目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

脚本带 UTF-8 BOM，Windows PowerShell 5.1 和 PowerShell 7 都能直接运行。

安装器使用 OpenCode V2 的全局自动发现目录，不修改 `opencode.jsonc`：

```text
%USERPROFILE%\.config\opencode\plugins\opencode-v2-metrics-plugin
```

运行数据和安装状态单独保存于：

```text
%USERPROFILE%\.config\opencode\opencode-v2-metrics-plugin-data
```

安装后如没有马上显示，在 OpenCode Desktop 中执行：

```text
/reload
```

## 卸载

安装器会复制固定位置的卸载器：

```text
%USERPROFILE%\.config\opencode\uninstallers\opencode-v2-metrics-plugin\uninstall.cmd
```

即使删除原始 ZIP 和解压目录，也可以运行：

```cmd
uninstall.cmd
```

保留安装数据以便以后恢复：

```cmd
uninstall.cmd -KeepData
```

卸载会清理本插件旧版本遗留的 `plugin-tools`、旧配置 marker 和运行副本，不会修改 Niuma 插件、provider、agent、MCP 或 `auth.json`。

## 更新

解压新版本后直接再次运行 `install.ps1`，不需要先卸载。安装器使用 `manifest.json` 清理旧版本中已经不存在的文件，并在失败时尝试恢复旧副本。

## 运行逻辑

服务端通过 OpenCode V2 事件收集：

- `session.step.started`
- `session.text.started`
- `session.text.delta`
- `session.reasoning.delta`
- `session.step.ended`
- `session.step.failed`

并通过 `http.request` / `http.response` 钩子测量首包延迟（只读响应流首字节，不改写内容）。由于 V2 在首个字节到达之后才发出 `step.started`，计时先进入会话队列，在 step 建立时回填。

GUI 通过 V2 GUI 插件上下文的 `ctx.client.rpc(...)` 读取服务端指标，并在 ComposerPill 渲染。

### 多实例

全局插件会按 location 各实例化一份（每个工作目录一个）。`http.request` / `http.response` 钩子只在**会话所属目录**的实例里触发，而 `session.*` 事件流对所有实例可见。所以：

- 所有实例通过 `globalThis` 共享同一份指标状态，钩子测量到的首包任何实例都能读到；
- 事件按 `event.id` 去重，同一条事件只更新一次状态，其余实例只负责把最新快照推给自己的 GUI 订阅者，不会重复累计。

没有这层共享时，给界面供数的实例往往不是收到钩子的那个，首包就会一直是空值。

指标严格按 `sessionID` 隔离。新会话不会继承旧会话数据；收到 `session.deleted` 后会清理对应的内存指标。插件不保存每个会话的历史文件，内存缓存也有固定上限。

服务端对高频 `delta` 事件做了 100ms 节流，避免每个 token 都做一次深拷贝和 RPC 广播。

## 开发

```powershell
npm install
npm run typecheck
npm run build
```

构建产物为 `dist/gui-experimental.cjs`。最终用户不需要 Node.js 或构建依赖，发布 ZIP 已包含构建产物。

## 更新日志

### v1.6.1

- 修复空闲时仍显示「实时」和上一步数值的问题：标签与数值绑定同一数据源，回合结束即切回「平均」。
- 平均速度改为端到端口径，思考、首包等待都计入。
- 实时速度同样从模型调用开始计时，与平均口径一致。
- 恢复缓存命中率显示（v1.6.0 遗漏）。
- 速度 / 首包 / 缓存三段改为常驻，缺值显示 `—`，不再整段消失。
- 首包拿不到时降级显示「到达」（首字时间）；思考阶段的第一个 reasoning chunk 也算首字。
- 只统计 primary 请求，标题生成等辅助请求不再抢走首包计时。
- 首包计时增加会话级兜底匹配，模型 id 在钩子与事件中不一致时仍能绑定。
- 去掉跨会话的 `lastMetric` 回退，新会话不再显示其它会话的指标。
- 新增 45 秒静默判定，被打断的回合不会永久停留在「实时」。
- `delta` 事件广播节流到 100ms，降低长回复时的 CPU 开销。
- 修复 `install.ps1` / `uninstall.ps1` 在 Windows PowerShell 5.1 下的解析错误（UTF-8 BOM）。

### v1.6.0

- 新增网络首包、完整生成耗时、平均首包、平均生成耗时。

### v1.5.0

- 严格按 sessionID 隔离指标；删除会话时清理内存记录；移除跨会话持久化快照。

## 隐私

插件只处理本地会话指标，不上传提示词、回复正文、文件内容或凭证。
