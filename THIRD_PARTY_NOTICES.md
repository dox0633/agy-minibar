# 第三方开源许可与致谢声明 (Third-Party Notices)

本项目本身遵循 [MIT License](LICENSE)。`toolkit/` 目录中整合了以下优秀的 MIT 开源项目与社区贡献，特此声明并致谢：

## 1. Antigravity-Chinese-Localization（桌面端界面汉化）

- **上游仓库**：<https://github.com/antigravity-cn-community/Antigravity-Chinese-Localization>
- **作者与贡献者**：`aabbWei` 及 `antigravity-cn-community` contributors
- **采用版本**：Release `v2.34.0`
- **采用文件**：`toolkit/i18n/zh-CN.json`、`toolkit/i18n/i18n-runtime.js`
- **许可证**：MIT License

## 2. antigravity-context-viewer（ASAR 引擎、汉化运行时封装与系统增强内核）

- **上游仓库**：<https://github.com/elviscjn-cjn/antigravity-context-viewer>
- **许可证**：MIT License（`Copyright (c) 2026 Antigravity Context Viewer Contributors`）
- **参考与精简适配模块**：
  - `toolkit/lib/asar-engine.mjs`（改编自 `asar-engine.js` 与独立 `preload.js` 汉化注入逻辑）
  - `toolkit/lib/enhance-core.mjs`、`toolkit/lib/macos-binary-utils.cjs`（精简剥离自 `meter-enhance.js` 与 `macos-binary-utils.js`，仅保留提示词档位替换与等长中文标题能力）

## 3. Go embed.FS 提示词精简与中文标题补丁原创贡献

- **来源**：GitHub `PR #4` 贡献者 `@Jia131313`（Go `embed.FS` 系统提示词槽位原位替换、`v2.29+` `applyEdits` 校验兼容、以及等长 ASCII 中文会话/章节标题双向可逆补丁）

---

### MIT License 原文

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
