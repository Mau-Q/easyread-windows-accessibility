# 选区自动翻译

在网页双语或 PDF 阅读器中选中文字、松开鼠标后，选区下方自动出现翻译卡片。鼠标选区稳定后立即发起请求，拖动过程中不请求；键盘连续扩选保留 150 毫秒防抖。译文流式显示；选择新的内容、关闭卡片或按 Escape 会取消旧请求。屏幕下方空间不足时卡片移到上方，并避让原选区工具栏。

译文来源按顺序为：完整选中的段落已有译文、完全匹配且译法唯一的论文术语、相同位置和上下文的独立结果缓存、模型生成。只有完整对应才复用已有段落译文，部分句子不做猜测截取。已有译文每次从当前论文读取，模型结果只在成功完整结束后缓存。所有结果仅显示在浮窗中，不写入原文、paper.json 或问 AI 的对话。

模型请求包含论文标题、章节、选区所在段落附近的原文、相邻段落和相关术语。只要求输出选区译文，不要求解释。默认使用独立 Codex 通道：自动优先选择当前模型名单中的 `gpt-6-luna`，推理强度 `low`；连接预热复用，每次选区使用临时线程。此配置独立于问 AI 与全文翻译，保存选词设置不会修改其模型或推理强度。

## 接入 API

打开“设置 → 选词翻译”，将“翻译来源”切换为 API，填写：

- API 基础地址，例如服务商的 `/v1` 地址，也可填完整接口地址。
- 模型名称：服务商提供的模型 ID。
- API 协议：OpenAI 兼容 Chat Completions 或 Responses。
- API Key：保存在本机；界面和配置查询只返回已保存标记。留空保留原 Key。
- API 推理强度：可选，仅当服务商支持时填写。

Chat Completions 接口使用 SSE `choices[].delta.content`；Responses 使用 `response.output_text.delta`。也兼容返回完整 JSON 的服务。失败、取消或长度截断的结果不会缓存。API 请求由本地 Python 服务发出，因此浏览器不直接接触 API Key，也不依赖服务商的 CORS 配置。

API 使用独立 HTTPX 连接池，复用 TCP/TLS 连接并协商 HTTP/2；服务商不支持时使用 HTTP/1.1。沿用环境和 macOS 系统代理与 bypass 设置，每次请求单独附上当前密钥，不自动重试模型 POST。预热只初始化连接池，不发送额外模型请求。请求的提示词、上下文和输出额度不因连接复用而改变。

显式启用推理时，输出额度至少为 8192 token，给隐藏推理留出空间；不会把单词译文的短长度作为整个推理请求的额度。DeepSeek 官方 V4.1 Flash 使用 `https://api.deepseek.com`、模型 `deepseek-flash`、Chat Completions 协议，推理强度可填写 `max`。完成响应会记录配置的强度、实际返回模型和服务商报告的用量。

## 本地接口

POST 请求沿用现有服务的 `X-Token` 校验：

- `/api/p/<paper-id>/selection-translation`：`quote`、`anchor` 或按顺序排列的 `anchors`、`key`（en/zh）、`request_id`，可带 `source_hashes`、`start`、`prefix`、`suffix`；返回 NDJSON 元数据、`t` 流式片段、最终 `done/text/timing` 或 `error`。
- `/api/selection-translation/config`：只更新选词翻译设置。
- `/api/selection-translation/cancel`：传入 `request_id`，取消对应请求。
- `/api/selection-translation/warm`：预热独立 Codex 连接，或初始化 API 连接池；不调用模型。

测速时使用 `refresh: true` 跳过结果缓存，`force_model: true` 跳过已有译文复用，保证计时包含真实模型调用。默认请求不需要这两个字段。完成响应的 `timing` 区分 `cached` 与 `reused_existing`，并包含准备时间、首片段时间、总时间、实际模型和可用的用量信息。API 还记录 `http_version`、`connection_reused`、`connection_ms` 和 `response_headers_ms`，便于区分连接建立与服务商返回阶段；不记录密钥或隐藏推理内容。

## 验证

`tests/test_selection_translation.py` 验证上下文、配置隔离、缓存、取消、来源版本和两个 API 协议。`tests/e2e_selection.cjs` 使用本机替身验证真实浏览器的自动浮窗、位置、跨段和数学选区、旧请求取消、PDF、API 设置与原文件保持。真实模型延迟需要另外在实际网络和服务商上测量，替身回归不代表模型速度。
