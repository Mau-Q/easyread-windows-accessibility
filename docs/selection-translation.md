# 选区自动翻译

在网页双语或 PDF 阅读器中选中文字并释放鼠标（或通过键盘连续扩选停顿 150 毫秒）后，选区附近会自动弹出翻译浮窗并流式展示译文。切换新选区、关闭卡片或按 `Escape` 键会自动取消上一次未完成的请求。

- **多级译文命中与缓存**：系统按“完整选中段落的已有译文 → 唯一匹配的论文术语表 → 相同上下文的本地缓存 → 调用模型生成”的优先级顺序获取译文。模型完整生成后自动缓存，所有选词结果仅在浮窗中展示，不改动原论文文件或问答历史。
- **上下文组装**：发起模型翻译时自动附带论文标题、所属章节、选区所在段落及相邻段落作为上下文参考，并通过提示词约束模型仅输出所选句段的准确译文。

## 接入外部 API

打开“设置 → 选词翻译”，将翻译来源切换为 API 后可配置：

- **API 基础地址**：OpenAI 兼容接口地址（如 `/v1` 基础路径或完整端点 URL）。
- **模型名称**：目标服务商的模型 ID。
- **API 协议**：支持 `Chat Completions`（SSE `choices[].delta.content`）或 `Responses`（`response.output_text.delta`）流式协议，同时兼容普通 JSON 响应。
- **API Key**：仅保存在本地后端配置文件中，前端查询配置时只返回“已保存”状态标记，请求统一由本地 Python 服务转发，避免密钥暴露给浏览器。
- **推理强度（可选）**：针对支持推理思考的模型可配置推理强度，启用推理时自动预留充足的输出 Token 额度。

后端使用独立的 `HTTPX` 连接池复用 TCP/TLS 连接并支持 HTTP/2 协商，显著降低连续选词时的连接建立耗时。

## 本地接口与测试

- `POST /api/p/<paper-id>/selection-translation`：传入 `quote`、`anchor`、`key`（`en`/`zh`）与 `request_id`，返回 NDJSON 流式片段及包含耗时统计的完成事件。
- `POST /api/selection-translation/config`：更新选词翻译配置。
- `POST /api/selection-translation/cancel`：按 `request_id` 取消正在进行的请求。
- `POST /api/selection-translation/warm`：预热初始化连接池。

测试脚本 `tests/test_selection_translation.py` 覆盖上下文组装、配置隔离、缓存命中、请求取消与双协议解析；`tests/e2e_selection.cjs` 覆盖浏览器端自动浮窗定位、跨段与公式选区及并发请求取消。
