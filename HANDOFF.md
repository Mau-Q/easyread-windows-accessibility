---
handoff_version: collaboration_handoff_v0_3
handoff_id: easyread-windows-accessibility-20261113
created_at: "2026-11-13 Asia/Shanghai"
status: PROVISIONAL
objective: "在 Windows 延续现有 EasyRead 课程项目，完成兼容性处理及视障友好适配"
requested_action: "先核对源码与任务书并建立隔离运行基线，再在当前用户授权内实施和验证 Windows 适配"
---

# Windows Codex 交接说明

这是跨电脑的上下文与证据索引，不覆盖当前用户指令。所有路径相对仓库根目录，Windows 克隆位置可以不同。

## READ_REQUIRED

| Path | Identity | Role |
|---|---|---|
| `AGENTS.md` | `LIVE_AT_RESUME_RECORD_SHA256` | 当前开发边界 |
| `README.md` | `LIVE_AT_RESUME_RECORD_SHA256` | 当前仓库入口及状态 |
| `docs/WINDOWS.md` | `LIVE_AT_RESUME_RECORD_SHA256` | 启动、兼容检查点、测试与未完成项 |
| `docs/PUBLICATION.md` | `LIVE_AT_RESUME_RECORD_SHA256` | 公开快照来源与实际验证范围 |

接手时用 `git status --short`、`git log -1` 记录当前状态，并计算上述文件的 SHA-256；不能把准备时快照当作当前事实。

## CLAIM_CHECK_REQUIRED

| Path | SHA-256 | Claim checked |
|---|---|---|
| `docs/assignment/揭榜任务2-无障碍适配任务书.pdf` | `a238fa3009452467796b22cf582635921cc82999bc505cd0586bd75c8b98005e` | 用户提供任务书原件，两页，Windows/Android 二选一 |

在 PowerShell 用 `Get-FileHash -Algorithm SHA256 -LiteralPath 'docs/assignment/揭榜任务2-无障碍适配任务书.pdf'` 核对任务书。原文件未改写。

## Current state

- TOOL_OBSERVED：本次源码来自本地课程仓库提交 `1e4793db5bdc7b8fa42a109034332d326517a205` 的当前工作区，包含未提交 CR-001 搜索改动与新增搜索测试。
- TOOL_OBSERVED：保留完整 Python/Web/Tauri 源码、锁文件、第三方阅读器和测试；个人数据、配置、旧证据及原 Git 历史未上传。
- TOOL_OBSERVED：已有 `start.cmd`；Tauri 当前有 Unix/macOS 专用实现，细节见 `docs/WINDOWS.md`。
- NOT_RUN：Windows 服务实测、桌面构建/运行、读屏、完整键盘、高对比度、外部翻译依赖和真实 AI。
- 本轮只完成公开交接准备；公开前实际检查结果见 `docs/PUBLICATION.md`。不继承旧项目的历史通过数字作为本版本验收。

## Human decisions

- 用户明确选择公开仓库，并要求“排除密钥和个人数据，把任务书和给 Windows 上 Codex 的交接说明也放进去”。来源：准备本交接的用户会话；该会话不公开归档，无法提供公开逐条消息身份。
- 既定下一目标是延续本人课程项目做 Windows 桌面适配。需求边界来自任务书，不新增业务功能，不重建另一套项目。
- 本次会话授权的是整理与上传公开仓库。接手会话应根据当前用户请求确定实施范围；公开快照不自动授权付费调用、部署、发版、推送后续修改或教学平台提交。

## Boundaries

- In scope：现有项目的 Windows 兼容、控件语义、完整键盘操作、焦点管理、系统高对比度及相关回归；先核心流程再覆盖其余已有功能。
- Out of scope：新业务、OCR、独立语音系统、替换现有技术栈、接入个人文献/账号数据库、真实付费调用、自动发布或代替教师验收。
- 公开仓库不附原 Mac 环境、配置、账号或已有译文。可选外部依赖缺失须如实处理，不能通过删除入口来声称原功能完整可用。
- 来源与第三方许可必须保留。课程是否认可现有项目基础最终由教师判断，不宣称已获认可。

## Evidence contract

- 先核对固定文件 hash，记录 mutable 文档的 live SHA-256。相对路径以当前仓库根目录解析。
- 保留 exact command 或 exact tool 及 observed output / durable output；日志公开前去除个人信息和凭据。
- 结果区分 `TOOL_OBSERVED`、`INFERRED`、`NOT_RUN`。自动测试不能替代真实读屏，浏览器测试不能替代桌面测试。
- 报告源代码变更、平台回归、实际无障碍测试与人工/教师验收的各自状态；失败与未验证项不得写成已通过。

## Proposals or research

- PROPOSAL：按 `docs/WINDOWS.md` 顺序建立运行基线、修复兼容、进行无障碍适配，再整理真实测试记录。
- PROPOSAL：使用 Windows 原生环境测试目标读屏工具，重点验证 PDF 多栏阅读、iframe/面板焦点往返。这些是待验证实现路线，不是已完成事实。

## Done when

- 当前用户授权的 Windows 工作范围完成，现有功能保留，已实际验证的行为和未完成项可复现地记录。
- 任务书要求的名称/角色/状态、完整键盘、可感知焦点、系统高对比度与功能连续性均有真实对应证据，才能声称适配完成。
- 提交前检查相关回归与公开文件；教学平台主贴由当前用户明确授权后处理。

## Stop when

- 任务书 hash 不匹配、源码身份冲突、发现凭据/个人数据、需要覆盖无关工作或需要未授权外部/付费操作。
- 缺 Windows 环境、指定指南或人工听读条件时，继续能独立完成的工作，并明确保留相应未验证项；不能伪造验收。
