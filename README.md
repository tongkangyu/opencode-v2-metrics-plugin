# OpenCode V2 Metrics Plugin

一个面向 OpenCode V2 Desktop 的通用指标插件，在窗口底部显示最近一次模型步骤的：

- **速度**：输出 tokens / 秒
- **首字**：从模型步骤开始到首段文本开始的时间（TTFT）
- **缓存**：缓存命中率

插件使用 OpenCode V2 的标准会话事件和 GUI 插件 API：

- `session.step.started`
- `session.text.started`
- `session.step.ended`
- `session.step.failed`
- Desktop GUI 的 `window.bottom` slot

它不修改模型请求，不管理供应商，不读取 API Key、`auth.json` 或其他凭证。

## 兼容性

- OpenCode V2 Desktop
- 目标 SDK：OpenCode V2.2.2
- GUI 插件 API：`./gui-experimental`（OpenCode 官方标记为 experimental）
- Windows 安装脚本需要 PowerShell

## 指标定义

### 回复速度

```text
output tokens / (完整响应时间 - 首段文本时间)
```

### 首字到达时间

```text
首段文本事件时间 - 模型步骤开始时间
```

### 缓存命中率

```text
cache.read / (input + cache.read)
```

插件同时保留原始缓存读写 Token 数据在服务端状态中，GUI 只显示当前摘要。

## 安装

### 使用发布压缩包

1. 解压 `opencode-v2-metrics-plugin.zip`。
2. 进入解压后的 `opencode-v2-metrics-plugin` 目录。
3. 执行：

```powershell
.\install.ps1
```

如果执行策略阻止脚本：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

安装脚本会自动识别当前用户的 OpenCode 全局配置目录，默认位置为：

```text
%USERPROFILE%\.config\opencode\
```

如果设置了 `XDG_CONFIG_HOME`，则使用其下的 `opencode` 目录。安装过程不会写死用户名路径。

运行副本安装到：

```text
<OpenCode配置目录>\plugins\opencode-v2-metrics-plugin\
```

### 持久卸载器

安装时会额外保存一个独立卸载器：

```text
<OpenCode配置目录>\plugin-tools\opencode-v2-metrics-plugin\uninstall.ps1
```

因此安装后可以删除原始压缩包和解压目录，仍然能够卸载：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File "$env:USERPROFILE\.config\opencode\plugin-tools\opencode-v2-metrics-plugin\uninstall.ps1"
```

如果使用了 `XDG_CONFIG_HOME`，请从对应配置目录下的 `plugin-tools` 运行卸载器。

## 更新

拿到新版本压缩包后，直接运行新版本的 `install.ps1`，**不需要先卸载旧版本**。

更新流程会：

1. 复用相同插件目录和配置标记；
2. 将新文件先复制到临时目录；
3. 替换旧运行副本；
4. 清理旧版本已经不存在的文件，避免残留；
5. 更新持久卸载器和版本清单；
6. 替换失败时尝试恢复旧运行副本。

## 卸载

如果原始解压目录还在：

```powershell
.\uninstall.ps1
```

如果原始目录已删除，使用上面的持久卸载器即可。

卸载只删除本插件自己的配置项和运行副本，不修改：

- provider 配置
- agent 配置
- MCP 配置
- `auth.json`
- 其他插件

安装前的配置备份保存在持久插件工具目录中。

## 开发和构建

最终用户不需要安装 Node.js 或构建依赖，压缩包已经包含 `dist/gui-experimental.cjs`。

开发者修改源码后可以运行：

```powershell
npm install
npm run typecheck
npm run build
```

构建产物为：

```text
dist/gui-experimental.cjs
```

## 隐私

插件只处理 OpenCode 已经产生的本地会话指标，不上传提示词、回复正文、文件内容或凭证。

## 许可证

MIT License，详见 `LICENSE`。
