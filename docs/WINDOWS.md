# Windows 开发与验证

## 当前状态

截至 2026-11-13，此公开仓库只完成源码整理与交接准备。已有 `start.cmd`，不等于当前全部功能已经在 Windows 验证。

| 项目 | 状态 |
|---|---|
| Windows Python 服务与浏览器界面 | NOT_RUN；已有启动脚本，待实测 |
| Windows Tauri 构建、启动、退出 | NOT_RUN；存在已知平台兼容点 |
| 目标读屏软件实际朗读 | NOT_RUN |
| 纯键盘、焦点与系统高对比度 | NOT_RUN |
| 真实 AI 服务、原生 PDF 翻译外部环境 | NOT_RUN；未随仓库提供 |

首次 GitHub Actions 被账号账单锁定阻止，所有测试作业在执行步骤前就停止；见 [公开整理记录](PUBLICATION.md)。云端测试没有产生 Windows 通过或失败证据。先在接手电脑运行本地验证，账号所有者处理账单阻塞后再恢复云端测试；不因该阻塞删除测试或伪造通过。

## 环境和隔离启动

Python 建议先用 3.12。基础服务不需要编译 Tauri。桌面开发需 Node.js/npm、Rust MSVC 工具链、Microsoft C++ Build Tools（C++ 桌面开发和 Windows SDK）以及 WebView2。参考 <https://v2.tauri.app/start/prerequisites/>，安装时按实际 Windows 架构选择。

以下为仓库根目录下的 PowerShell 操作示例。使用新的本地测试目录，实际 `config.json` 永远不要提交。

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
$env:PYTHONUTF8 = '1'
$env:EASYREAD_HOME = Join-Path $env:LOCALAPPDATA 'EasyRead-accessibility-dev'
New-Item -ItemType Directory -Force $env:EASYREAD_HOME | Out-Null
# 只在这个新测试目录首次使用时复制；不得覆盖已有配置。
if (!(Test-Path (Join-Path $env:EASYREAD_HOME 'config.json'))) {
    Copy-Item config.example.json (Join-Path $env:EASYREAD_HOME 'config.json')
}
.\.venv\Scripts\python.exe -m easyread serve --open
```

也可从同一终端运行 `cmd /c start.cmd`；前台 Python 命令更便于看错误并结束测试服务。创建测试账号，自行导入可公开的文本型 PDF；不要复制开发者个人文献和数据库。先验证本地功能，真实 AI 另行配置与授权。

## 已知兼容检查点

1. `desktop/src-tauri/src/main.rs`：无条件导入 `os::unix::process::CommandExt`；使用 Unix 进程组及 `libc::kill`；固定 `.venv/bin/python`；多处调用 `/usr/bin/open`。需按 Windows 实现对应行为并保留 macOS 路径。
2. `desktop/package.json` 和 `tauri.conf.json`：现有 `--bundles app`/macOS 目标需增加 Windows 构建方式；`build.command` 是 macOS 脚本。
3. `easyread/pdf_translation.py`：检查 `ps`、`os.killpg`、信号和子进程生命周期。外部 HJFY 运行环境、模型配置及已有译文不随源码提供。不得将功能缺失伪装成适配完成。
4. PDF 重排的外部 worker 等可选能力参见 `docs/pdf-reflow.md`；其依赖不能从本机绝对路径推断为已安装。
5. 根 README 是当前入口，旧设计说明带有历史状态；启动脚本存在或旧测试文件存在不代表本次 Windows 验证通过。

先用 `npm ci` 在 `desktop` 安装锁定依赖。当前 `npm run build` 是 macOS 命令，修正 Windows 构建配置后再执行。桌面程序仍依赖 Python 环境；独立安装包若需要，必须另行验证其 Python 运行时和资源布局。Windows 打包参考 <https://v2.tauri.app/distribute/windows-installer/>。

## 回归命令

在仓库根目录、隔离数据环境下运行：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
Get-ChildItem tests/test_*.cjs | ForEach-Object { node --test $_.FullName; if ($LASTEXITCODE -ne 0) { throw "Failed: $($_.Name)" } }
cargo test --release --locked --manifest-path desktop/src-tauri/Cargo.toml
py -3.12 scripts/check_public_tree.py
```

Python 和 Node 测试中的 mock/fixture 不证明真实模型或读屏有效。`tests/e2e*.cjs` 是额外浏览器脚本，部分需要 Playwright、本地服务和测试样本，先读脚本再运行；不假定其依赖已经安装。

## 无障碍工作与记录

先取得并核对任务书指定的《Windows 应用无障碍可访问性开发指南（2022 年第四届科技无障碍发展大会）》；本仓库只有任务书，未收录该指南。通用 W3C/APG 文档可补充，不能声称替代指定指南。

- 建立现有全部用户功能清单，先打通登录、导入、搜索、打开 PDF、阅读与翻页、笔记保存、返回的核心流程，再覆盖其余现有入口。
- 检查控件名称/角色/状态、列表选中与读屏焦点、弹窗进入/退出/焦点恢复、侧栏和引用跳转、异步成功与错误提示。
- PDF 正文有文字层不代表双栏阅读顺序正确。实际验证读屏进入正文、连续阅读、翻页，以及从 iframe 返回工具栏/笔记面板。
- 检查系统高对比度下的文字、边框、选中态和键盘焦点；普通深色主题不能代替该测试。
- 每项记录系统与应用版本、读屏工具版本、操作步骤、预期/实际结果、修改位置及剩余问题。截图/日志如需公开，先去除个人信息与配置。
- 人工听读、实际键盘操作与教师验收分别记录；无法取得的证据标 `NOT_RUN`，不编造通过。

## 提交

任务书要求在教学平台主贴写适配说明与测试记录；上传开源项目时附仓库链接。标题为“揭榜适配-姓名-视障友好适配”，截止时间以课程通知为准。它未强制要求独立安装包、视频或 Word 报告。整理人未在本轮提交教学平台。
