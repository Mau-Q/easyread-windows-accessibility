# Windows 开发与测试说明

本文档记录 EasyRead 在 Windows 平台下的构建启动步骤、兼容性与无障碍适配实现、测试环境及实测验证结果。系统沿用原有的 Python 后端服务、原生 Web 界面和 Tauri 桌面端架构。

## 任务书与无障碍开发标准

适配工作依据 [课程无障碍适配任务书](assignment/揭榜任务2-无障碍适配任务书.pdf) 与《[Windows 应用无障碍可访问性开发指南](https://cdn1.ime.sogou.com/Windows%E5%BA%94%E7%94%A8%E6%97%A0%E9%9A%9C%E7%A2%8D%E5%BC%80%E5%8F%91%E6%8C%87%E5%8D%971.0.pdf)》（由腾讯搜狗输入法、阳光读屏发起，争渡读屏、NVDA 中文网、上海有人公益基金会共同参与编制，参见 [NVDA 中文网开发文档](https://nvdacn.com/index.php/devDocs.html)），并结合 [Microsoft Accessibility Checklist](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-checklist) 与 W3C WAI-ARIA 规范，重点围绕控件名称/角色/状态、全键盘导航、焦点管理、双栏阅读顺序及系统高对比度主题开展适配与验证。

教学平台提交的适配总结见 [TEACHING_POST_DRAFT.md](TEACHING_POST_DRAFT.md)。

## 实测环境配置

| 环境项 | 版本与配置 |
|---|---|
| 操作系统 | Windows x64（10.0.26300） |
| Python 运行时 | Python 3.12.10（项目 `.venv` 虚拟环境） |
| Node.js / npm | Node 26.13.0 / npm 12.2.2 |
| 终端环境 | PowerShell 7.6.9 / Windows PowerShell 5.1 |
| Rust / Cargo | 1.100.0（`x86_64-pc-windows-msvc` 工具链） |
| C++ 编译工具链 | Visual Studio Build Tools 2022（17.14.45，VC Tools + Windows SDK 26100） |
| 桌面框架 / 内核 | EasyRead 0.1.0，Tauri 2.12.1，Microsoft Edge WebView2 157.0.4341.46 |
| 读屏软件 | NVDA 2026.3.1（中文界面，Windows OneCore 语音引擎） |
| 自动化测试工具 | Playwright 1.65.0、`axe-core` 4.14.0（锁定于 `tests/package-lock.json`） |

## 构建与启动

在仓库根目录下创建 Python 虚拟环境、安装依赖并构建桌面程序：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
cd desktop
npm ci
npm run build
cd ..
.\start-desktop.cmd
```

若本机使用 `uv` 管理 Python 环境，也可执行 `uv venv --python 3.12 .venv` 与 `uv pip install --python .venv/Scripts/python.exe -e .`。

`start-desktop.cmd` 默认使用仓库目录下的 `runtime\windows-dev` 作为独立数据目录（首次启动时自动复制 `config.example.json`），并将 WebView2 用户配置目录置于同一路径下；也可在启动前通过 `$env:EASYREAD_HOME` 指定自定义数据目录。

若仅需在浏览器中调试后端与前端界面，可直接运行：

```powershell
$env:EASYREAD_HOME = 'D:\SE\easyread-validation\browser'
$env:PYTHONUTF8 = '1'
.\.venv\Scripts\python.exe -m easyread serve --open
```

## 平台兼容与无障碍改造清单

| 模块 / 文件 | 适配与修复内容 |
|---|---|
| `desktop/src-tauri/src/main.rs` | 适配 Windows Python 虚拟环境路径探测、子进程树干净退出与原生外部链接打开；处理 WebView2 `tauri.localhost` 启动白名单与 Windows Python 启动器父子 PID 握手；将导出下载文件框归属至主窗口句柄 |
| `desktop/src-tauri/src/windows_keys.rs` | 接入 WebView2 `AcceleratorKeyPressed` 事件，使正文获得焦点时仍能响应 `Ctrl+Q` 并异步触发原生退出确认；保留 `F10`、`Shift+F10`、编辑键与读屏快捷键的原生传递 |
| `pdf_translation.py`、`process_lock.py` | 引入 `psutil` 进行只读进程身份校验（替代在 Windows 下会终止进程的 `os.kill(pid, 0)`）；适配 Windows 无控制台进程组、任务取消进程树清理、`msvcrt` 文件锁与 UTF-8 编码 |
| `pdf_reader.py`、`access.py` | 适配 Windows `file://` URL 路径转换；确保 NTFS 下同文件大小修改仍重新计算哈希校验；统一 Windows 下翻译运行时路径配置 |
| `arxivhtml.py`、`server.py`、`account_http.py` | 统一跨平台 UTF-8 字节写入以保持文件哈希一致；显式注册 `.mjs` 的 `application/javascript` MIME 类型以修复 Windows 下 PDF.js 加载空白；在登录页白名单中放行 `accessibility.js` |
| `common/accessibility.js`、`accessibility.css` | 统一补齐控件名称、角色与状态语义；实现可见键盘焦点框、模态框进入/退出焦点锁定、背景 `inert` 隔离与焦点恢复；适配 `forced-colors` 系统高对比度主题并提升常规文字对比度 |
| `library/` 模块 | 实现文献列表选中态与 `aria-activedescendant` 实时同步；支持方向键、`Home/End`、`Enter`、`Shift+F10` 键盘导航；支持分类管理与侧栏宽度键盘调节；将文件上传 `input` 移入活动模态框内以正常调起系统文件对话框 |
| `util.js`、`confirm.js`、`settings-chat.js` | 补齐下拉菜单键盘导航；避免确认弹窗误捕获全局 `Enter`；将模型配置卡片重构为平级原生按钮，支持纯键盘新增、设为默认、修改和删除模型 |
| `reader-shell.js`、`report-panel.js` | 实现 `F6` / `Shift+F6` 在顶部工具栏、阅读正文与活动侧边面板之间循环切换；关闭面板后自动恢复触发焦点；点击阅读报告引用跳转后自动聚焦正文 |
| `pdf-dual/pane.js` | 为正文 `iframe` 补充可访问名称与文字层焦点支持；支持选文后按 `Shift+F10` 调出操作条；双页同屏时按逻辑当前页同步页码状态 |
| `arxiv-annotations.js`、`arxiv-reader.js` | 支持网页阅读正文键盘聚焦与选文 `Shift+F10` 批注菜单；点击摘要或批注跳转后同步转移实际键盘焦点 |
| `reader/chat.js`、`pdf-dual/chat.js` | 将对话列表项重构为原生按钮并补充选中状态语义，使重命名与删除按钮均可通过键盘聚焦操作 |

## 功能与无障碍实测结果

| 功能模块 | 实测操作与验证结果 | 验证环境 |
|---|---|---|
| 注册 / 登录 / 账号隔离 | 创建独立账号并重启重新登录；验证双账号文献与阅读状态隔离 | 原生桌面端 + 本地后端 |
| PDF 导入 | 纯键盘调起 Windows 系统文件选择框输入路径导入 BERT 论文，并验证自动化批量导入 | 原生文件框 + 桌面端 |
| 中文题名搜索与列表导航 | 编辑中文题名后按中文关键词检索（CR-001），使用方向键、`Home/End` 导航，`aria-activedescendant` 与选中行一致 | 原生桌面端 |
| 分类 / 星标 / 阅读状态 | 纯键盘新建、重命名、绑定和删除分类（保留文献），切换星标与阅读状态，键盘调节侧栏宽度 | 原生桌面端 |
| 上下文菜单与外部入口 | 使用 `Shift+F10`、方向键、`Escape` 操作上下文菜单並恢复焦点；验证引用复制、外部链接与导出入口 | 原生桌面端 |
| 论文删除与二次确认 | 在确认弹窗中先测试取消保留，再测试确认永久删除并核对本地存储清理 | 原生桌面端 |
| 设置中心与模型管理 | 纯键盘遍历六个设置页；完成模型的添加、设为默认、修改与删除操作 | 原生桌面端 |
| PDF 阅读与双栏布局 | `F6` 进入正文，测试页码跳转、前后翻页、双栏同步、缩放调节及原文/译文/并排视图切换 | 原生桌面端 |
| NVDA 双栏与长文读屏 | `NVDA+Down` 连续朗读两页双栏合成样本（20 段正文按左栏 1–5 → 右栏 1–5 顺序准确播报）；BERT 论文从首页连续朗读覆盖摘要、引言与相关工作 | NVDA 2026.3.1 + 原生桌面端 |
| 个人笔记与划线批注 | 手动编辑并保存整篇笔记；使用 `Shift+F10` 添加划线与批注，点击引用跳回正文并聚焦 | 原生桌面端 |
| 保存异常恢复 | 模拟 `503` 保存失败时完整保留草稿，拦截未保存离开，点击重试后成功落盘 | 原生桌面端 |
| 阅读报告生成与恢复 | 使用本地 Qwen2.5-1.5B 模型真实生成四栏目阅读报告并落盘，引用可准确定位至 PDF 第 1 页；同时覆盖失败重试与“仅重试保存”分支 | 本地大模型 + 原生桌面端 |
| 论文问答与图片问答 | 本地文本模型完成带引用问答与流式对话保存；本地 SmolVLM-256M 视觉模型完成双色图片上传识别与会话持久化 | 本地文本/视觉模型 + 桌面端 |
| 选词自动翻译 | 在 arXiv 网页论文中选中部分句段，完成知情授权确认、流式请求与选区精准翻译返回 | 本地大模型 + 原生桌面端 |
| 历史记录与文件导出 | 键盘打开历史记录并通过 Windows 原生另存为对话框导出 JSON 文件，验证落盘文件结构完整 | 原生保存框 + 桌面端 |
| arXiv 网页论文阅读 | 导入 `2411.00640v1`，验证 `F6` 跨区切换、摘要定位聚焦、`Shift+F10` 划线持久化与笔记保存 | 原生桌面端 |
| 系统高对比度与 200% 缩放 | 启用 Windows“夜空”高对比度主题（`forced-colors`）及 200% 缩放，核验文字、边框、选中态与键盘焦点显示 | Windows 系统高对比度主题 |
| 进程生命周期与退出保护 | 验证重复启动、关闭窗口后 Python/WebView2 进程树完整退出；有未保存笔记时按 `Ctrl+Q` 弹出确认框，键盘选“否”保留草稿 | 原生桌面端 |
| PDF 结构化重排 | 运行 Zotero `document-worker` 生成结构化重排包与 `full-mapping.json`，两页双栏 20 个段落全部精确匹配 | Windows 本地 Worker |

## 自动化回归测试命令

在仓库根目录下运行全量单元测试与代码树检查：

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
node --test tests/test_*.cjs
cargo check --release --locked --manifest-path desktop/src-tauri/Cargo.toml
cargo test --release --locked --manifest-path desktop/src-tauri/Cargo.toml
py -3.12 scripts/check_public_tree.py
```

- **Python 后端回归**：**235 项测试全部通过**（含文件链接、多用户隔离、SQLite 事务、进程生命周期与 MIME 映射测试）。
- **Node 前端测试**：**30 项测试全部通过**（含 CR-001 中文题名搜索、轮询与阅读进度保存测试）。
- **Rust 桌面壳层测试**：**3 项测试全部通过**，Release 构建通过。

## 桌面端无障碍与 NVDA 复现命令

1. 生成双栏无障碍测试 PDF 并启动带调试端口的桌面端进行 E2E 与 `axe-core` 检查：

```powershell
npm ci --prefix tests
.\.venv\Scripts\python.exe scripts/make_accessibility_sample.py D:\SE\easyread-validation\fixtures\sample.pdf
$env:EASYREAD_HOME = 'D:\SE\easyread-validation\desktop'
$env:EASYREAD_HJFY_HOME = 'D:\SE\easyread-validation\hjfy-fixture'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=19222'
.\start-desktop.cmd

$env:EASYREAD_CDP = 'http://127.0.0.1:19222'
$env:EASYREAD_SAMPLE = 'D:\SE\easyread-validation\fixtures\sample.pdf'
$env:EASYREAD_EVIDENCE = 'D:\SE\evidence\reproduction'
node tests/e2e_windows_accessibility.cjs
node tests/e2e_windows_extended.cjs
node tests/e2e_windows_chat.cjs
node tests/e2e_windows_html.cjs
node tests/e2e_windows_axe.cjs
```

2. 原生文件另存为与原生菜单快捷键验证：

```powershell
node tests/e2e_windows_download.cjs
powershell -ExecutionPolicy Bypass -File tests/native_menu_keys.ps1
```

3. NVDA 真实语音输出采集与双栏朗读顺序校验：

```powershell
.\tests\nvda_reading.ps1 -Nvda D:\DevTools\NVDA-2026.3.1\nvda.exe -Config D:\SE\easyread-validation\nvda-config -PrivateLog D:\SE\evidence\nvda-private.log -Title 双栏无障碍 -Seconds 48
.\.venv\Scripts\python.exe scripts/check_nvda_sample.py D:\SE\evidence\nvda-private.log
```

## Windows 平台兼容性与无障碍关键问题修复记录

在从 macOS 迁移至 Windows 并开展无障碍实测的过程中，定位并修复了以下 16 项关键工程问题：

1. **进程存活探测兼容性**：Windows 下调用 `os.kill(pid, 0)` 会直接终止目标进程导致回归测试中断；改为通过 `psutil` 进行只读进程身份核验后全量回归顺畅通过。
2. **换行符与文件路径指纹一致性**：修复 Windows CRLF 换行符导致的哈希差异、原生 `file://` URL 路径排序以及 NTFS 同字节长度文件修改的指纹重算逻辑。
3. **子进程管理与流式事件同步**：适配 Windows 下的 Python 子进程启动入口、监督进程退出等待与流式事件顺序。
4. **Windows 下 PDF.js 正文渲染空白**：定位到 Windows 注册表默认未将 `.mjs` 映射为 JavaScript MIME 类型；在后端静态服务中显式声明 `.mjs` 为 `application/javascript` 后 PDF.js 正常渲染。
5. **系统文件选择框焦点拦截**：导入弹窗打开时，原先位于背景层的 `<input type="file">` 被背景 `inert` 属性禁用导致无法弹出系统文件框；将其移入活动模态框内部后，纯键盘可正常呼出系统文件对话框。
6. **低缩放比例下双页页码同步**：当页面缩小至两页同屏可见时，将工具栏逻辑页码与 PDF.js `currentPageNumber` 严格同步，解决翻页后页码显示滞后的问题。
7. **设置弹窗内菜单与模型卡片键盘可达性**：修复模态框内部下拉菜单被背景 `inert` 误伤的问题；将模型列表中原本嵌套的交互元素重构为平级原生 `<button>`，并统一补齐 `iframe` 标题与文字对比度，使 10 个核心界面状态全部通过 `axe-core` WCAG 2.1 A/AA 扫描。
8. **Windows 系统高对比度主题联动**：在开启 Windows“夜空”高对比度主题时清除浏览器默认媒体仿真覆盖，确保 WebView2 原生 `forced-colors` 样式准确生效。
9. **原生另存为对话框键盘导出**：结合 CDP 与 Windows 原生 `SendInput` 脚本驱动系统保存对话框，完成历史记录 JSON 导出与文件解析校验。
10. **异步重绘与 `iframe` 焦点等待**：在键盘自动化脚本中按稳定 DOM 状态与显式起始页同步焦点，消除异步加载带来的焦点竞态。
11. **未登录页无障碍脚本加载**：在 `account_http.py` 未登录静态资源白名单中精确放行 `/web/js/common/accessibility.js`，确保登录页同样具备完整的键盘与焦点的无障碍增强（同时保持业务脚本 401 权限拦截）。
12. **WebView2 正文焦点下的 `Ctrl+Q` 退出**：遵循 WebView2 `AcceleratorKeyPressed` 官方约定，在捕获 `Ctrl+Q` 时标记 `Handled` 并异步派发原生退出确认，既支持正文内快捷键退出又避免阻塞渲染线程。
13. **HTTP 持久连接（Keep-Alive）请求体清理**：修复选词翻译首次返回未授权提示时残留请求体阻塞同一 TCP 连接后续请求的问题。
14. **本地小参数模型 JSON 围栏解析**：适配 Qwen2.5-1.5B 输出带 Markdown 代码围栏的报告 JSON 解析，并在保持严格结构校验、来源枚举与原文引用校验的前提下调整提示词示例。
15. **部分选区翻译精确边界控制**：优化选词翻译提示词结构，将待译选区置于提示词末尾并与上下文参考段落明确区分，确保模型仅输出选中句段的译文。
16. **Zotero 重排 Worker 的 Windows 盘符解析**：修复 Node `--import` 将 Windows `D:` 盘符误解析为 URL Scheme 的问题，统一转为标准 `file://` URI 并显式指定 UTF-8 读写，顺利完成双栏 PDF 的 20 段结构化映射。
