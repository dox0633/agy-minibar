# 贡献指南

感谢关注 agy-minibar！欢迎 Issue 与 PR。

## 开发环境

- Node.js ≥ 22.5（用到内置 `node:sqlite`，仅 IDE 配额桥）
- Google Antigravity 2.0 桌面版（实机调试用）
- 无需 `npm install` —— 项目零外部依赖

```powershell
git clone https://github.com/dox0633/agy-minibar.git "$env:USERPROFILE\.gemini\config\plugins\agy-minibar"
```

## 项目结构

```
plugin.json                  插件清单（Antigravity 自定义发现机制）
sidecars/
  bar/
    sidecar.json             sidecar 声明（AUX_PANE 入口）
    main.mjs                 sidecar 主进程：取数 + CDP 注入 + 账号切换
    inject.js                页面端：Shadow DOM 状态条与账号面板
    accounts.mjs             token 库 + Windows 凭据 swap（PowerShell 桥）
    idequota.cjs             IDE 配额桥（Kite usageCache 只读）
    lib/transcript.mjs       transcript 解析库（改编自 jule-x，MIT）
docs/                        截图（均为虚构演示账号）
```

## 开发工作流

1. **改页面端**（`inject.js`）：保存即可 —— sidecar 监测 mtime 热重载，下一轮 tick 自动生效，无需重启。
2. **改 sidecar**（`main.mjs` / `accounts.mjs`）：需要重启 Antigravity（sidecar 由宿主托管）。
3. **调试日志**：`sidecars/bar/minibar.log`，含 `BOOT / TICK / SWITCH_* / SINGLETON_* / UNCAUGHT` 事件。
4. **语法检查**：`node --check <file>`（提交前请对全部改动文件执行）。

### 强制约束（违反会导致用户界面异常）

- **绝不向 React 托管节点树插入元素**：状态条宿主挂在 `document.body`，`position: fixed`，纯 Shadow DOM。
- **全局只允许一个 `#agy-minibar-host`**：`update()` 每轮清理非当前实例；多实例叠加会把输入区撑高导致整页滚动（v1.0.1 修复的教训）。
- **不写宿主任何文件**（app.asar / 宿主配置）；唯一落盘是插件自身目录内的 `minibar.log` 与 `sidecar_data/agy-minibar/` 下的 token 库。
- **空值显示 `—`**：宁可空着不给假数据（见 v1.0.0 中压缩步骤耗时被误报为 TTFT 的教训）。

## 提交规范

- 使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`
- 涉及行为变化的 PR 请在描述里附 12 秒稳定性采样结果（ hosts=1、文本抖动次数）。

## 发布流程（维护者）

1. 更新 `plugin.json` 版本号与 `CHANGELOG.md`。
2. 语法检查：`node --check sidecars/bar/*.mjs *.cjs`（实际逐文件）。
3. 实机验证：启动 Antigravity → 状态条渲染 → 切对话跟随 → 12s 稳定性 → 账号面板。
4. 敏感扫描：仓库（含 git 历史）不得含真实邮箱 / token / 本机用户名。截图一律使用虚构账号。
5. 打 tag 并发布 Release：`git tag vX.Y.Z && git push origin vX.Y.Z`。

## 行为准则

保持友善、就事论事。所有交互遵循 [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)。
