# Changelog

本项目所有重要变更都记录在此文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。










## [1.2.5] - 2026-11-15

### 修复

- **切回来额度又变错**：账号 A 切到 B 再切回 A 时，A 的卡片重新显示
  IDE 旧缓存（可能与实时值相差数天），尽管 A 刚刚作为当前账号时
  我们已经拿到了它的实时配额。

### 新增

- **实时配额捕获历史**（`live-quota.json`）：账号成为当前时，
  其 LS 实时配额自动记录到本地；非当前账号的卡片优先展示这份
  「切换时捕获的实时值」（悬停提示含捕获时间），7 天后过期回落到
  IDE 缓存。实测：A→B→A 往返，A 的额度全程保持切换时的准确值。

[1.2.5]: https://github.com/dox0633/agy-minibar/compare/v1.2.4...v1.2.5

## [1.2.4] - 2026-11-15

### 修复

- **非当前账号额度标签增加缓存时效提示**：悬停显示缓存快照的年龄
  （如「3 天前」）与周额度 7 天重置说明——缓存值可能显著偏离当前实际剩余，
  用户可据此判断可信度。

### 说明（数据源边界）

- 非当前账号的实时配额**无法获取**：Language Server 仅加载当前账号，
  Google 消费者配额端点（`v1internal:*`）不对其它账号的 token 开放
  （实测 `fetchAvailableModels` / `retrieveUserQuotaSummary` 均返回
  PERMISSION_DENIED）。IDE 侧 Kite 缓存是唯一可行来源。
- 当前账号不受影响：与状态条同源的实时值。

[1.2.4]: https://github.com/dox0633/agy-minibar/compare/v1.2.3...v1.2.4

## [1.2.3] - 2026-11-14

### 变更

- **账号卡片视觉**：圆点语义改为「当前账号才亮绿点」，其它账号一律灰点；
  右侧标签统一为「切号」（非当前账号），不再区分「已存 / 需登录」——
  是否可秒切由悬停额度标签与点击后的流程自然呈现。
- 额度标签悬停提示修正（此前被后续赋值覆盖，未显示缓存标注）。

[1.2.3]: https://github.com/dox0633/agy-minibar/compare/v1.2.2...v1.2.3

## [1.2.2] - 2026-11-14

### 修复

- **非当前账号的周额度显示不准**：此前所有账号一律使用 IDE 缓存快照
  （可能滞后数天），当前账号因此与状态条的实时数值矛盾。
  现在当前账号改用与状态条同源的 **Language Server 实时配额**，
  非当前账号保留缓存值并加 `*` 标注（悬停提示为缓存快照）。

### 新增

- **切换后凭据补写**（借鉴 Antigravity-Manager）：杀 language_server
  子进程后再补写一次凭据，覆盖旧进程在"写凭据→杀子进程"窗口内
  回写旧 token 的竞态，确保宿主约 2 秒后拉起的新 LS 读到的一定是
  目标账号凭据。实测往返切换全链路 5 秒内收敛。

[1.2.2]: https://github.com/dox0633/agy-minibar/compare/v1.2.1...v1.2.2

## [1.2.1] - 2026-11-14

### 新增

- **生成感知延迟重启**：切换账号时若当前会话正在生成回复
  （transcript 20 秒内有写入），自动把 Language Server 重启
  推迟到生成结束后——不中断正在输出的内容，凭据仍即时写入。

### 说明

- LS 重启仅影响后台 AI 服务进程（约 3.5 秒端到端），
  对话窗口、历史记录、输入框全程不受影响。

[1.2.1]: https://github.com/dox0633/agy-minibar/compare/v1.2.0...v1.2.1

## [1.2.0] - 2026-11-14

### 修复（关键）

- **切换后桌面端登录态不更新**：凭据 blob swap 后 Language Server 内存中仍是
  旧 token（LS 仅在启动时读取凭据），导致设置菜单显示的账号不变——
  之前的行为只是"凭据层切换"，不是真正的热切换。

### 新增

- **切换即重启 Language Server**：凭据写入成功后自动结束
  `language_server.exe`，宿主秒级拉起新实例，新实例从凭据管理器
  读取**目标账号**的 token——设置菜单、配额池、模型列表全部跟随新账号，
  全程无需重启整个应用。
- 实测往返切换（A → B → A）：凭据管理器、LS 内存态、设置菜单、
  状态条显示四层全部收敛，端到端约 10 秒。

[1.2.0]: https://github.com/dox0633/agy-minibar/compare/v1.1.4...v1.2.0

## [1.1.4] - 2026-11-14

### 修复

- **真实鼠标点击账号无反应**：宿主容器 `pointer-events: none` 会拦截鼠标事件，
  编程式 `.click()` 能触发面板但真实鼠标点击不能。现在改为按元素粒度开启：
  账号项、面板与登录确认条各自 `pointer-events: auto`，其余区域保持穿透，
  不再依赖运行时切换宿主容器的 pointer-events（也消除了由此带来的面板闪隐）。

[1.1.4]: https://github.com/dox0633/agy-minibar/compare/v1.1.3...v1.1.4

## [1.1.3] - 2026-11-14

### 修复

- **账号面板弹出位置**：面板此前渲染在视口左上角（宿主容器未跟随锚点）。
  现在面板从账号项上方弹出、右对齐锚定，含视口边缘避让
  （上方放不下改到下方、水平越界自动收进）。

[1.1.3]: https://github.com/dox0633/agy-minibar/compare/v1.1.2...v1.1.3

## [1.1.2] - 2026-11-14

### 修复

- **账号点击无反应**：`switchToAccount` 调用了不存在的 `writeActiveBlobFromFile`
  （正确名称为 `writeActiveBlobFile`，重命名遗留笔误），导致凭据写入阶段直接抛错，
  所有切换请求在面板上表现为「切换中…」后无结果。实测往返切换
  （A → B → A）凭据层与 UI 层均正确收敛。

[1.1.2]: https://github.com/dox0633/agy-minibar/compare/v1.1.1...v1.1.2

## [1.1.1] - 2026-11-14

### 新增

- 账号面板显示每个账号的 **Gemini 周额度标签**（如 `周93%`），数据来自 Antigravity IDE Kite 扩展的本地缓存（只读桥接，`idequota.cjs`），切换前一眼看出哪个账号还有余量。

### 变更

- 截图与文档改用虚构演示账号（`someone@gmail.com` 系列），不含任何真实账号信息。
- 启动诊断日志细化（`SERVER_OK` 附带端口、锁竞争事件独立记录）。

### 修复

- 账号面板 `mailWrap` 渲染：额度标签在部分主题下未跟随行容器的问题。

## [1.1.0] - 2026-11-14

### 新增

- **账号热切换**：状态条新增「账号」项（位于 5小时 额度之前），点击弹出账号面板。
  - 列出本机登录过的全部 Google 账号（`~/.gemini/google_accounts.json` + 本地 token 库）。
  - 已备份 token 的账号**免重启秒切**；未备份的走一次 Google 登录即可入库。
  - 切换实现：Windows 凭据管理器 `gemini:antigravity` blob swap + `google_accounts.json` / `active-account.json` 双指针同步。
  - OAuth 抓取流程：登录完成后状态条出现「我已登录」确认条，点击抓取新凭据入库。
- **token 库**（`accounts.json`，权限 0600）：sidecar 每次启动自动备份当前活跃账号，切换前再备份一次，任何时刻可切回。
- 免 fetch 的页面 ↔ sidecar 通道：payload 下行 + `update()` 返回值上行，绕开主窗口 CSP 对 loopback fetch 的拦截。

### 修复（安全审计）

- `switchToAccount`：邮箱格式校验、大小写不敏感匹配、已激活短路、切换前凭据备份、
  凭据 blob 经临时文件传递（规避命令行长度与转义问题）、PS 端写前 JSON 结构校验、
  失败后一致性复查。
- `upsertAccount`：严格校验 email 与 token（支持桌面版对象形态 `{access_token, refresh_token, ...}`）。
- `runPs`：`pwsh` 不可用时回退 `powershell.exe`，补 `-ExecutionPolicy Bypass` 与 `maxBuffer` 防护。
- 登录确认条超时 10s → 30s（Google 登录普遍较慢）。

## [1.0.1] - 2026-11-14

### 修复

- **启动时状态条数值闪动**。两个叠加根因：
  1. 多次应用重启遗留的僵尸 sidecar 进程同时注入，各自携带不同缓存快照逐 tick 互相覆盖；
  2. 「尾部快速读取」在不同时刻解析出不同的最新步骤，TPS 在数值与空值间反复横跳。
- 措施：单实例锁（锁文件 + PID 心跳 + 死持有者抢占），`stats()` 统一全量解析后缓存。
- 实测：12 秒采样文本抖动从 27 次降为 0。

## [1.0.0] - 2026-11-13

### 新增

- 首个公开版本。
- 状态条常驻输入框正下方：上下文圆环（按官方模型窗口计百分比，颜色跟随 256K 自动压缩线）、
  会话 Token 合计（M 单位）、轮数、纯解码 TPS、缓存命中率、5 小时/周额度剩余。
- 免依赖安装（Node.js 内置模块）、纯本地取数（transcript + Language Server RPC）、
  不修改 `app.asar`。
- 单实例守护、深浅色主题自适应、对话切换 1 秒内跟随（字节偏移增量扫描）。

[1.1.1]: https://github.com/dox0633/agy-minibar/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/dox0633/agy-minibar/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/dox0633/agy-minibar/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/dox0633/agy-minibar/releases/tag/v1.0.0
