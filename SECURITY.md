# 安全策略

## 报告漏洞

如果你发现了安全漏洞，请**不要**创建公开 Issue。

请通过 [Security Advisories](https://github.com/dox0633/agy-minibar/security/advisories/new) 私密报告，或发邮件至仓库主页配置的联系邮箱。我们会在 72 小时内确认收到。

请在报告中包含：

- 复现步骤（越具体越好）
- 影响评估（能读到/写到什么）
- Antigravity 版本与操作系统

## 支持版本

| 版本 | 支持状态 |
|---|---|
| 1.1.x | ✅ |
| < 1.1.0 | ❌ 请升级 |

## 安全模型说明

了解本项目的设计边界有助于判断什么算漏洞：

**数据访问范围（设计如此）：**

- 只读 `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl`（本地会话日志）
- 只读 `~/.gemini/google_accounts.json` 与 `~/.gemini/antigravity/active-account.json`（账号指针）
- 只读 Antigravity IDE 的 `state.vscdb` 中 Kite 扩展的用量缓存
- 读写 Windows 凭据管理器条目 `gemini:antigravity`（仅在与账号切换功能交互时）
- 与本地 Language Server（`ANTIGRAVITY_LS_ADDRESS`，宿主注入）通信

**明确不做：**

- 不向任何远程主机发送数据（零网络出站；CDP 通信仅限 127.0.0.1）
- 不修改 `app.asar` 或宿主配置文件
- 不将 token 库上传、同步或备份到任何外部位置

**敏感数据落盘位置**（均为本机）：

| 文件 | 内容 | 保护 |
|---|---|---|
| `~/.gemini/antigravity/sidecar_data/agy-minibar/accounts.json` | 各账号 OAuth token | 权限 0600（Windows 上尽力而为） |
| `~/.gemini/antigravity/sidecar_data/agy-minibar/credswap.ps1` | 凭据读写脚本（自动生成，无凭据内容） | 用户目录默认权限 |
| `sidecars/bar/minibar.log` | 运行事件（不含 token 与邮箱） | 插件目录 |

**已知边界**（非漏洞，但请知悉）：

1. token 库是明文 JSON。它保护级别等同 Antigravity 自身的凭据存储（Windows 凭据管理器对同用户进程可读）；若你的威胁模型包含同用户恶意软件，任何密码管理器都帮不了你。
2. 切换账号写入凭据后，Language Server 在下一次鉴权检查时才使用新 token；期间旧 token 在内存中仍有效至其自然过期。
3. 免 fetch 指令通道（`window.__AGY_MINIBAR.pendingSwitch`）依赖主窗口全局对象；同页面的其它扩展理论上可以读写它。这是 Antigravity sidecar 沙箱模型的限制，所有 sidecar 插件共享同一暴露面。

## 报告隐私问题

如果你认为本项目收集或传输了不该收集的数据，请同样按上述私密渠道报告——这类问题与安全漏洞同等优先处理。
