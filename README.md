# OpenCode V2 Metrics Plugin

OpenCode V2 Desktop 指标插件，在输入框上方显示会话平均速度、实时速度、首字时间和缓存命中率。

## 重要限制

这是 **Desktop GUI 插件**。指标栏显示在 OpenCode Desktop 的 Composer 状态区域，不会显示在纯 TUI/CLI 窗口中。

## 安装

解压后在本目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

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
- `session.step.ended`
- `session.step.failed`

GUI 通过 V2 GUI 插件上下文的 `ctx.client.rpc(...)` 读取服务端指标，并在 ComposerPill 渲染。

指标严格按 `sessionID` 隔离。新会话不会继承旧会话数据；收到 `session.deleted` 后会清理对应的内存指标。插件不保存每个会话的历史文件，内存缓存也有固定上限。

## 开发

```powershell
npm install
npm run typecheck
npm run build
```

构建产物为 `dist/gui-experimental.cjs`。最终用户不需要 Node.js 或构建依赖，发布 ZIP 已包含构建产物。

## 隐私

插件只处理本地会话指标，不上传提示词、回复正文、文件内容或凭证。
