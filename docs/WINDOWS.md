# Windows 开发与验证

更新于 2026-11-21。按任务书选择 Windows 桌面路线，保留 Python、原生 Web、Tauri 和已有业务。教师验收已按用户提供的状态登记。下文记录本机兼容与无障碍验证，以及真实模型、重排 worker 和 HJFY 的补测结果。

## 接收与规范

仓库为 <https://github.com/Mau-Q/easyread-windows-accessibility>，初始提交 `c1a771877af0a4f854cc4a4a01ec3149e7bbf34c`，初始工作区干净；开发分支 `windows-accessibility`。已读 AGENTS、README、HANDOFF、原 WINDOWS、PUBLICATION 和完整两页任务书。原件 SHA-256 为 `a238fa3009452467796b22cf582635921cc82999bc505cd0586bd75c8b98005e`，核对一致，未修改原件。

指定指南从 [NVDA 中文网开发文档](https://nvdacn.com/index.php/devDocs.html)取得。[原 PDF](https://cdn1.ime.sogou.com/Windows%E5%BA%94%E7%94%A8%E6%97%A0%E9%9A%9C%E7%A2%8D%E5%BC%80%E5%8F%91%E6%8C%87%E5%8D%971.0.pdf)封面为《Windows 应用无障碍开发指南》，正文使用完整的“Windows 应用无障碍可访问性开发指南”名称，共 43 页。发起方为腾讯搜狗输入法、阳光读屏，参与方含争渡读屏、NVDA 中文网和上海有人公益基金会。按第 4 章检查名称/角色/状态、导航键盘和系统高对比度；[大会同期报道](https://static.nfnews.com/content/202206/16/c6593256.html)用于核对 2022 年背景。[Microsoft 清单](https://learn.microsoft.com/en-us/windows/apps/design/accessibility/accessibility-checklist)和[最佳实践](https://learn.microsoft.com/en-us/windows/win32/winauto/accessibility-best-practices)仅作补充。指南本地留存，没有改授 MIT 许可。

任务书要求现有功能、读屏、键盘、焦点、高对比度和真实记录，没有强制独立安装器、视频或 Word 报告。教学平台主贴草稿见 [TEACHING_POST_DRAFT.md](TEACHING_POST_DRAFT.md)，未实际发布。

## 实测环境与隔离

| 项目 | 本机实测 |
|---|---|
| Windows | x64，系统版本 10.0.26300 |
| Python | 3.12.10，Windows 本机虚拟环境 |
| Node / npm | 26.13.0 / 12.2.2 |
| 终端 | PowerShell 7.6.9，原生文件框 helper 使用 Windows PowerShell 5.1 |
| Rust / Cargo | 1.100.0，MSVC 工具链 |
| C++ 工具 | Build Tools 2022 17.14.45，VC Tools + Windows SDK 26100 |
| 桌面 / WebView2 | EasyRead 0.1.0，Tauri 2.12.1，WebView2 157.0.4341.46 |
| 读屏 | NVDA 2026.3.1 portable，中文界面，Windows OneCore，禁用插件 |
| 自动检查 | Playwright 1.65.0、axe-core 4.14.0，tests/package-lock.json 锁定 |

检出目录 `D:\SE\easyread-windows-accessibility`；数据 `D:\SE\easyread-validation`；证据 `D:\SE\evidence`。使用新测试账号、合成内容与公开论文；未接入原个人库。配置引擎为 none、关闭自动翻译；所有 AI 状态测试均标注 fixture。

按用户要求，缓存、临时目录、Rust 和 Build Tools 主体尽可能放 D 盘。Build Tools 提供 Rust 桌面构建所需链接器及 Windows SDK，不需要完整 Visual Studio IDE。Windows 必需的系统共享组件没有手工搬移；磁盘审计与迁移证据留在项目外。

## 构建与启动

在仓库根目录执行，保留源码目录和 Python 环境：

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
cd desktop
npm ci
npm run build
cd ..
.\start-desktop.cmd
```

本机 Python 没有自带 pip，实际用 `uv venv --python 3.12 .venv` 和 `uv pip install --python .venv/Scripts/python.exe -e .` 安装相同依赖。不要复制 Mac 虚拟环境。

`start-desktop.cmd` 默认使用检出目录下 `runtime\windows-dev`，WebView2 profile 默认也在该数据目录下，检出在 D 盘时这些数据都在 D 盘。仅首次复制 config.example.json，不覆盖已有配置。可先设置独立 `EASYREAD_HOME`；已有显式 WEBVIEW2_USER_DATA_FOLDER 会保留。首次注册再登录；退出后重复运行同一脚本。日常启动不启用调试端口。

当前是依赖源码和 Python 环境的本机桌面版本。`npm run build` 使用 `--no-bundle`，exe 不能冒充完全独立的安装包。macOS 的 `npm run build:mac` 保留，Unix 分支保留；本轮没有运行 Mac/Linux 回归。

仅需浏览器诊断时：

```powershell
$env:EASYREAD_HOME = 'D:\SE\easyread-validation\browser'
$env:PYTHONUTF8 = '1'
.\.venv\Scripts\python.exe -m easyread serve --open
```

## 实际修复

| 源码 | 问题与结果 |
|---|---|
| desktop/src-tauri/src/main.rs | Windows Python 路径、进程树退出、原生外链；关闭窗口真正退出；WebView2 tauri.localhost 启动白名单；Windows Python 重定向器父 PID 握手；下载框归属于主窗口 |
| desktop/src-tauri/src/windows_keys.rs | WebView2 正文获得焦点时接收既有 Ctrl+Q，异步交回原生退出确认；F10、Shift+F10、编辑键和读屏键保持原处理。使用已锁定的 webview2-com 版本，不添加全局热键 |
| pdf_translation.py、process_lock.py | psutil 只读身份检查，避免 Windows os.kill(pid,0) 结束进程；Windows 无控制台进程组、取消树、msvcrt 锁、UTF-8、显式 HJFY 运行时 |
| pdf_reader.py、access.py | Windows file URL 转换、NTFS 同长度修改仍核对指纹、模型授权与阅读器共用 Windows HJFY 默认/覆盖路径 |
| arxivhtml.py、server.py、account_http.py | UTF-8 字节写入与哈希一致；显式 .mjs MIME，修复 PDF.js 在 Windows 空白；登录页允许精确的无障碍脚本路径，不开放账号代码 |
| common/accessibility.js、accessibility.css | 名称/角色/状态；可见焦点、模态进入退出、背景 inert、Tab 限制、恢复焦点；系统色和常规文字对比度 |
| library 模块 | 选中与 active-descendant 一致；方向键/首尾/Enter/Shift+F10；分类键盘管理和宽度调整；元数据与状态语义；导入后重置排除该文献的筛选；文件 input 移入活动弹窗以恢复真实系统选择框 |
| util.js、confirm.js、settings-chat.js | 菜单键盘导航；模态内部菜单不被背景禁用；确认框不误接全局 Enter；模型卡片使用平级原生按钮，新增/默认/修改/删除可键盘操作 |
| reader-shell.js、report-panel.js | F6/Shift+F6 在工具栏、正文、活动面板往返；面板关闭恢复；报告引用跳转后聚焦正文 |
| pdf-dual/pane.js | 正文 iframe 命名、文字层焦点、Shift+F10 选文工具；两页同时可见时使用逻辑当前页，避免下一页已显示但工具栏仍报上一页 |
| arxiv-annotations.js、arxiv-reader.js | 网页正文可聚焦；选文 Shift+F10；摘要和批注定位设置实际焦点 |
| reader/chat.js、pdf-dual/chat.js | 对话原生选择按钮、选中状态、改名/删除按钮焦点可达 |

## 现有功能与验证范围

`TOOL_OBSERVED` 表示实际工具观察；AI fixture、真实后端、读屏日志、人工确认、教师验收分别记录。

| 入口/要求 | 实际操作及结果 | 范围 |
|---|---|---|
| 注册/登录/隔离 | 新目录新账号，重启后登录；跨账号权限回归 | TOOL_OBSERVED，桌面和真实本地后端 |
| PDF 导入 | 键盘打开系统文件框，输入 BERT 路径并 Enter；另运行自动注入样本核心流程 | TOOL_OBSERVED，真实系统选择与 setInputFiles 分开记录 |
| 中文搜索/选中/元数据 | 编辑中文题名、搜索、方向键/首尾，active-descendant 对应实际行 | TOOL_OBSERVED，核心流程 + CR-001 |
| 分类/星标/状态/侧栏 | 新建/改名/分配/删除分类且保留文献，切换星标和状态，键盘调整宽度 | TOOL_OBSERVED，extended 真实持久化 |
| 菜单/引用/文件入口 | Shift+F10、方向键、Escape、恢复；保留复制格式、外链、文件夹、导出入口 | TOOL_OBSERVED 菜单与元数据；格式/权限由既有回归覆盖，未声称逐格式人工核对剪贴板 |
| 删除论文 | 专用合成副本先取消保留，再确认永久删除 | TOOL_OBSERVED，remaining 真实后端 |
| 全部设置/模型名单 | 六个设置页；新增、默认、修改、删除草稿模型，最终取消设置 | TOOL_OBSERVED，无实际 Key 或提供商调用 |
| PDF 阅读/布局 | F6 进入正文，页码、前后页、同步、缩放、原文/译文/并排、分栏键盘宽度 | TOOL_OBSERVED；译文使用本地合成产物，不证明翻译质量 |
| 双栏实际读屏 | NVDA+Down 完整读取合成样本两页。BERT 补测从首页进入连续阅读，语音日志覆盖摘要、引言及相关工作 | TOOL_OBSERVED。复杂公式、表格和全文的人体验证待补 |
| 笔记/批注/定位 | 整篇笔记手动保存，Shift+F10 划线、编辑批注，引用聚焦正文 | TOOL_OBSERVED；选区位置用受控 DOM Range 建立，后续键盘操作与真实保存 |
| 保存错误恢复 | 一次受控 503，草稿保留，取消离开，重试实际保存 | TOOL_OBSERVED，故障 fixture + 真实恢复 |
| 报告 | 失败、重试、只保存不重新生成、引用跳转。真实模型生成四栏报告并保存，引用可定位到原 PDF 第 1 页 | TOOL_OBSERVED。恢复分支用 fixture 覆盖 |
| 问答/会话 | 失败保留输入和引用、流式完成、仅保存、中断、改名/选择/取消删除/确认删除。真实模型的带引用问答和 PDF 聊天已保存 | TOOL_OBSERVED。恢复分支用 fixture 覆盖。图片问答的真实视觉模型待补 |
| 选词翻译 | 公开 arXiv 网页的一处部分选区通过授权确认、流式请求和结果返回。调整提示后只翻译所选句段 | TOOL_OBSERVED。同一连接中确认授权的回归已通过 |
| 历史记录/下载 | 打开/关闭恢复焦点，真实另存为输入 D 盘路径，落盘 JSON 可解析 | TOOL_OBSERVED，原始 CDP + 系统键盘保存框 |
| arXiv 网页 | 实际导入 2411.00640v1；F6、摘要焦点、Shift+F10 划线持久化、笔记返回 | TOOL_OBSERVED，公开网络源与真实本地存储 |
| 高对比度/低视力 | 200% 缩放可达；Windows 夜空主题下文字/边框/选中/焦点，原生 forced-colors | TOOL_OBSERVED，实际系统主题，测试后恢复 |
| 生命周期 | 重复启动、关闭及所启动 Python/WebView2 树清理；未保存笔记退出提示中键盘选“否”，草稿保留再手动保存 | TOOL_OBSERVED，无所属后台残留，不终止其他应用 |
| 重排 worker | 原版 Zotero worker 真实生成结构、SDT 包和候选证明，合成两页 20 段全部匹配 | TOOL_OBSERVED，本轮验证候选生成。候选仍为 preview |
| HJFY | 本机测试了官方 Windows 商店包 1.0.6.0 的引擎发现和实际启动 | 内部 `hjfy-pdf.exe` 出现 Windows 拒绝访问，原生翻译产物待有可独立启动的发行版后补测。取消/失败/产物身份由受控引擎回归覆盖 |
| 旧阅读/实验路径 | 上游已停用旧实验并重定向/410，历史文件和记录保留 | 本轮覆盖原有重排候选准备命令 |

## 回归命令与结果

Windows 管理员环境下 Python **235 项全部通过**。11 月 13 日普通权限日志中的 WinError 1314 是建立符号链接的系统权限限制，本轮使用管理员令牌运行了该用例。Node **30 项通过**，Rust release locked check 和 **3 项测试通过**，Windows release 桌面构建完成。桌面和读屏可在普通权限运行。

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
node --test tests/test_*.cjs
cargo check --release --locked --manifest-path desktop/src-tauri/Cargo.toml
cargo test --release --locked --manifest-path desktop/src-tauri/Cargo.toml
```

样本：`scripts/make_accessibility_sample.py` 生成两页双栏，每页 LEFT 1–5 后 RIGHT 1–5，本次文件 SHA-256 `c9eb7081200d193bbb5427f9e070faa23cb9cdd7f4e00408ce8d52428a86d55b`；[BERT 原论文](https://aclanthology.org/N19-1423/)和 [PDF](https://aclanthology.org/N19-1423.pdf)，SHA-256 `987545ffb087f1ece898142c403a516baeabeb70ce19089397fac6f7db12c3d4`；[arXiv 2411.00640v1](https://arxiv.org/html/2411.00640v1)用于真实网页阅读。原论文不随源码再次分发。

## 桌面复现

先构建并注册隔离测试账号 a11y_test（测试脚本中的密码仅适用于隔离数据），不要对个人数据运行这些脚本。CDP 只在测试启动时启用。

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

remaining 脚本另需 `EASYREAD_DELETE_SAMPLE` 指向不同指纹的可删除合成 PDF。并排测试先在显式 HJFY fixture 目录的 `Documents/synthetic/original.pdf` 放合成原文，在 `Documents/synthetic/Runs/fixture-v1/translated.zh-Hans.pdf` 放两页合成产物。本机是隔离目录的首个账号；普通后续账号使用其独立 home 下 `.hjfy`。这只模拟产物布局，绝非真实译文。没有译文时禁用译文/并排按钮是原业务预期。

下载测试：键盘打开历史阅读记录，断开 Playwright，再运行 `node tests/e2e_windows_download.cjs`。它用原始 CDP Enter 和 `tests/native_file_picker.ps1 -Save` 操作实际保存框，写入新的 D 盘文件并解析 JSON；不覆盖已有文件。Open/Save helper 使用 Windows PowerShell 5.1 和真实 SendInput。

原生菜单检查运行 `tests/native_menu_keys.ps1`：实际 SendInput F10 进入 Windows 菜单模式，再 Escape 退出；加 `-Quit` 实际发送 Ctrl+Q 并等待原生应用退出。只在隔离实例中运行。脚本先检查交互桌面，Windows 管理员提示/安全桌面不能当作应用按键失败。Ctrl+Q 的实现遵循 [WebView2 官方 AcceleratorKeyPressed 约定](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller#add_acceleratorkeypressed)，先设置 Handled，再异步安排原生确认，避免同步回调阻塞浏览器。

axe 检查文献库、导入、六个设置页、PDF、笔记共 10 个状态的 WCAG 2 A/AA、2.1 A/AA，最终零 violations；incomplete 仍需判断，不能称为认证。

## 实际 NVDA 和系统主题

官方 NVDA portable 使用独立配置。脚本前置真实原生窗口并发送 Ctrl+Home、Insert+Down、Ctrl 停止，记录实际 NVDA 语音输出事件，而非只读取可访问性树：

```powershell
.\tests\nvda_reading.ps1 -Nvda D:\DevTools\NVDA-2026.3.1\nvda.exe -Config D:\SE\easyread-validation\nvda-config -PrivateLog D:\SE\evidence\nvda-private.log -Title 双栏无障碍 -Seconds 48
```

实际日志观察到设置按钮的名称/角色，合成两页共 20 段，逐页完整 LEFT 1–5 → RIGHT 1–5，顺序核对通过。可运行 `python scripts/check_nvda_sample.py PRIVATE_LOG`，只输出合成标记摘要并检查实际 say-all 输入。公开 BERT 已进入正文并连续朗读开头。长论文整篇、公式表格及主观听读舒适度未据此宣称通过。原始日志可能含桌面其他内容，必须仅本地保留，不提交。

系统对比度使用 Windows 设置中的“夜空”并真正应用，核对 hc2.theme 和原生 WebView2 forced-colors，清除 Playwright 默认媒体覆盖，再检查画面。只改注册表标志位、普通深色或媒体模拟均不算通过。用户也已回复“已开启”。测试后恢复原 Custom.theme 与原对比度关闭状态。

## 失败与复测记录

原始失败保留在仓库外，修复后追加复测，不删除断言：

1. 初次 Python 中途退出：Windows os.kill(pid,0) 结束进程；改为 psutil 后才完成整套回归。
2. 换行哈希、file URI 排序、同长度篡改检测失败：字节写入/原生 URL 路径/Windows 重算指纹，最终完整回归通过。
3. POSIX fake engine、日志占用、流式事件竞争：显式 .py 入口，等待 supervisor 退出，修正事件顺序；断言保留。符号链接权限失败以管理员整套复测解决。
4. PDF 正文空白：Windows .mjs MIME 错误；修复后原生 PDF.js 加载。Tauri 启动页外链及重定向 Python PID 握手问题修复后重新构建运行。
5. 自动注入能导入、系统文件框打不开：input 被背景 inert，移入模态后真实键盘选择成功。
6. 低缩放页码错误：逻辑页码与 PDF.js currentPageNumber 同步，双页/缩放/同步实际复测。
7. 设置菜单被 inert、模型嵌套按钮、iframe 名称、可见名称不一致、低文字对比度：修复后模型增删改和 10 状态 axe 通过。
8. 系统对比度初次只改标志位，之后媒体默认覆盖掩盖实际主题：真正应用系统主题并清除覆盖，实际原生复测及恢复。
9. Playwright 下载取消：原始 CDP + 真实 Windows 保存框生成有效 D 盘 JSON；不是删除或绕过导出功能。
10. 测试的旧筛选、异步导入重绘、重复网页、已有页码和未等待 iframe 焦点曾导致假失败：等待实际 ID/稳定状态并设置明确起始页；不放宽最终业务断言。
11. 常规未登录启动拦截新增 accessibility.js：精确放行这一公开脚本，账号脚本仍为 401；新增真实 HTTP 回归通过。样式原本已在公开 CSS 白名单中。
12. 系统管理员提示曾使普通桌面键盘输入失效，未据此认定应用失败；确认取消后重新检查，F10 正常，另确认 WebView2 焦点下 Ctrl+Q 需适配。增加应用范围的事件接入后，实际 SendInput F10 和 Ctrl+Q 均通过。
13. 实际选词翻译首次返回授权提示时，HTTP 请求体留在持久连接中，下一次授权请求被读成无效语法。现在先读入同一请求的受限请求体，实际复测和持久连接断言通过。
14. Qwen 把报告 JSON 包在一个 Markdown 围栏内，并逐字复制示例的 `source` 枚举。改用合法值作为示例，接受完整单一围栏内的 JSON。结构校验、来源枚举和引用原句检查仍强制执行。报告和问答复测生成、保存、引用端点通过。
15. Qwen 第一次翻译了选区所在的整段。把实际选区放到提示末尾并明确标出参考文字的用途后，同一部分选区只返回所选句段的译文。
16. Zotero worker 第一次因 Node `--import` 把 `D:` 解析为 URL scheme 而失败。改为文件 URI 并显式使用 UTF-8 读写，独立输出目录复测成功，原 PDF 与 paper.json 指纹一致。

## 11 月 21 日补测复现与清理

- **本地真实模型。** 在 D 盘用 llama.cpp b10922 加载 Qwen2.5-1.5B-Instruct Q4_K_M，启动 `llama-server --host 127.0.0.1 --port 18089 --ctx-size 4096`，以一次性密钥限制访问。模型地址为 `http://127.0.0.1:18089/v1`。在独立 EasyRead 数据目录配置报告、聊天和选词翻译，导入四句合成 PDF，分别经授权起报告、问答和 PDF 聊天，再导入 arXiv `2411.00640v1` 测部分选区。真实问答与聊天正确返回 10 份文档，报告和问答的引用端点返回第 1 页，选词结果只翻译选中片段。复现脚本和结果位于本机 `D:\SE\evidence\2026-11-21\probe_local_model.py` 和 `real-model-results.json`。测试结束后删除权重、临时推理程序、下载包和临时配置，确认端口已关闭。[llama.cpp 构建](https://github.com/ggml-org/llama.cpp/releases/tag/b10922) · [Qwen 发布权重](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/main/qwen2.5-1.5b-instruct-q4_k_m.gguf)
- **真实重排。** 在 D 盘取项目锁定的 Zotero document-worker `9d11471391fc3f609a0d1e7012b82b9be6ca9c12` 与子模块并执行 `npm ci`。webpack 生成 worker 后，按上游 `scripts/build-assets` 用 PowerShell 复制所需资源，再执行上游 metadata 和 SDT 打包命令。用 `python -m easyread.reflow_prepare --workspace <合成文献目录> --worker-root <worker目录> --out <新目录>` 运行。`reflow-retest/full-mapping.json` 记录 20 段已匹配、0 段待确认。`cache-proof.json` 记录原文件和输出指纹。[Zotero 源码](https://github.com/zotero/document-worker/tree/9d11471391fc3f609a0d1e7012b82b9be6ca9c12)
- **HJFY Windows 商店包。** 安装后定位到 `Engines/Pdf/bin/hjfy-pdf.exe`。直接执行 `--help` 返回访问被拒绝，普通文件复制返回无法加密指定文件，未取得可独立使用的运行时。测试安装包位于 WindowsApps，已按用户要求卸载该版本并清理未完成的 D 盘副本。需要有官方可独立调用的 Windows 运行时才能完成 EasyRead 的原生 PDF 翻译联调。[Microsoft Store](https://apps.microsoft.com/detail/9pffshldt311)
- **真实 NVDA 补测。** 使用与首轮相同的 NVDA portable 和受控桌面数据，对 BERT 执行原生键盘 `Ctrl+Home`、`NVDA+Down`，采集 50 秒语音日志并检查章节标记，摘要、引言和相关工作均出现。可分享的布尔摘要位于 `nvda-bert-summary.json`，原始日志仍为私有证据。

## 证据与完成边界

本机 `D:\SE\evidence` 保存 python-final.txt、node-final.txt、cargo-check-final.txt、cargo-test-final.txt、desktop-build-final.txt、native-final-core.txt、native-final-extended.txt、native-final-chat.txt、native-remaining-final.txt、native-html-final.txt、native-final-axe/、real-system-contrast.json 和私有 NVDA 日志。源码只留脱敏说明、测试和生成器，不提交配置、数据库、截图、原始日志或构建物。

11 月 13 日普通权限的失败保留在 `python-final-unprivileged.txt`。11 月 21 日管理员复跑和退出码保存在 `D:\SE\evidence\2026-11-21\python-full-admin.txt` 和 `python-admin-exit.txt`。

提交检查：`python scripts/check_public_tree.py`、Gitleaks 8.30.1 的受检文件副本和 Git 历史扫描（redact=100）、git diff --check 和暂存清单复核。既有精确第三方例外不扩大。GitHub Actions 仍为原账单阻塞运行，9 个作业没有测试步骤；没有改账单/反复触发，云端不计通过。

剩余外部验收条件：

- **HJFY 原生 PDF 翻译及视觉模型图片问答仍待补。** 官方商店引擎无法从 EasyRead 启动。本地文本模型已验证报告、问答和选词翻译，图片问答需另有真实视觉模型。
- **人工听读体验仍待补。** 合成样本和 BERT 已观察到实际 NVDA 语音输出。全篇复杂表格、公式和目标用户的主观听读体验需真实使用者确认。
- **教师验收：已完成（按用户于 2026-11-21 提供的状态登记）。** 教学平台提交仍待完成，主贴保留在本地草稿中。
