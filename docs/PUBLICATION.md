# 公开整理记录

日期：2026-11-13（Asia/Shanghai）。用途：将当前课程版本交给 Windows 开发环境，准备视障友好适配。

## 来源

- 上游：<https://github.com/Edwardxlai/easyread>；保留根目录 MIT 许可证和第三方许可。
- 原本地课程仓库最近提交：`1e4793db5bdc7b8fa42a109034332d326517a205`。
- 本快照从当前工作区复制，额外纳入未提交的 `easyread/web/js/library/app.js` 搜索修改及未跟踪的 `tests/test_library_search.cjs`。
- 发布前 `app.js` SHA-256：`91f9832748c8eb95c00eb6886598247aac52ac5b784dd78ac2193e647577685e`。
- 搜索测试 SHA-256：`841ade2a1e2e72394673ac10f7268edafe663f72cd040670cf94cafb41e3dbe5`。
- 任务书原件 SHA-256：`a238fa3009452467796b22cf582635921cc82999bc505cd0586bd75c8b98005e`；PDF 完整复制，不改内容。
- 本公开仓库使用新的单独 Git 历史，未迁移原本地仓库 `.git`。上述原提交号用于来源定位，并非本公开仓库中的可检出提交；原历史留在本机。

## 整理范围

应用源码、第三方运行资源、测试及 npm/Cargo 锁文件保留。新增 README、Windows 开发说明、开发约定、配置示例、任务书与 HANDOFF；替换原桌面说明中依赖私有证据的入口。

不公开个人文献库、账号数据库、实际配置/API 密钥、阅读/翻译/问答缓存、旧课程报告、旧验收日志、截图与演示数据，也不公开原 Git 历史。旧材料制作和个人环境专用脚本未带入；这不删除原项目任何文件。历史设计说明仅作为参考，当前入口以根 README 为准。

## 实际验证

- TOOL_OBSERVED：在公开目录使用已有 Mac Python 环境、独立测试数据目录运行 `python -m unittest discover -s tests -p 'test_*.py'`，230 项通过，21.804 秒。未启动原个人 App，未接入原数据目录。
- TOOL_OBSERVED：`node --test tests/test_*.cjs`，30 项通过，包含 CR-001 搜索测试；这不是浏览器端到端或读屏测试。
- TOOL_OBSERVED：原样复制的应用代码、测试和第三方运行资源与源工作区逐文件 SHA-256 一致；整理改写的是入口文档与忽略规则，另增加公开交接文件。
- TOOL_OBSERVED：任务书原件与公开副本 SHA-256 一致，交接文件通过结构校验。
- TOOL_OBSERVED：Gitleaks 8.30.1 扫描公开目录，复核一处第三方压缩代码误报后无未解决匹配。`.gitleaks.toml` 只允许一个文件中的精确数组长度赋值表达式；未忽略整个文件。合成令牌负向检查证明同一路径的凭据仍会触发扫描。
- TOOL_OBSERVED：公开文件与原本地配置中非空凭据做精确值比对，无匹配；未输出凭据值。`python scripts/check_public_tree.py` 通过，禁止配置文件及合成令牌的负向检查通过。
- TOOL_OBSERVED：自有文件的 Git 差异格式检查通过。第三方文件原有行尾空白保持原样，未为消除格式提示改写其代码或许可证。
- 原扫描日志及测试日志仅本机保留；不将旧日志、个人路径或凭据写入公共材料。上述是本机扫描与回归结果，不能保证检测所有未知秘密，也不代表 Windows 或无障碍验收。
- TOOL_OBSERVED：首次公开提交 `3043da5a8019c0447746969955dc28fcc7c8efaa` 的远端 545 个文件与本地 Git 树逐项一致；任务书与 HANDOFF 的匿名下载内容和本地副本相同。仓库已确认为 PUBLIC。
- EXTERNAL_DEPENDENCY：首次 [GitHub Actions 运行](https://github.com/Mau-Q/easyread-windows-accessibility/actions/runs/43349953637) 被 GitHub 账号账单锁定阻止，作业没有执行任何测试步骤。该失败状态不表示应用测试已失败或已通过。需账号所有者处理 GitHub Billing 后再恢复云端回归；本次不重复触发、不修改账单设置。

后续发布前可安装 Gitleaks 并在仓库根目录运行 `gitleaks dir . --config .gitleaks.toml --redact=100` 及 `gitleaks git . --config .gitleaks.toml --redact=100`，分别检查工作区和拟公开 Git 历史。

## 待 Windows 接手

Windows 桌面运行、真实读屏、键盘、高对比度与外部翻译能力未验证。指定 2022 Windows 无障碍指南未收录，需在正式适配前取得并核对。GitHub 仓库发布不等于揭榜任务完成或教学平台提交。

## 后续 Windows 开发记录（2026-11-13）

以上“待接手”描述为公开整理时的历史状态。本轮在用户明确扩展授权后完成 Windows 本地构建与兼容修复、控件和焦点适配、实际原生桌面/键盘/NVDA/系统对比度及回归验证，指定指南已取得并核对。当前结果、失败复测、证据位置和真实模型/人工验收边界统一见 [WINDOWS.md](WINDOWS.md)。修改仅本地保存与提交，没有自动推送、发布 Release、处理账单或提交教学平台。既有来源和许可证保留。
