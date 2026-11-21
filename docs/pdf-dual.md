# 原版式双语 PDF 对照阅读

文献库顶部的“PDF 对照”入口支持在不重排 PDF 原版式的前提下，将英文原 PDF 与中文译文 PDF 左右并排对照阅读，同时保持现有文献的“开始阅读”、原 PDF 及网页阅读入口行为不变。

样例文件位于 `.pdf-dual-experiments/dual-doremi/`，包含原文与译文 PDF、`manifest.json`（记录版本、SHA-256 指纹、页面边界和页内文字）、`reader.json`、`history/reader.log.jsonl` 及 `context-previews.json`。

## 批注与引用数据协议（v1）

每条笔记保留原有的 `id/kind/body/anchor/quote/color/created/updated` 字段，并扩展 `pdf` 坐标与文件身份对象；“问 AI”中的每条 `refs[]` 采用相同的 `anchor/quote/pdf` 结构：

```json
{
  "anchor": "translation-p1",
  "quote": "选中文字",
  "pdf": {
    "schema": 1,
    "document_id": "dual-doremi",
    "side": "translation",
    "asset_id": "translation-v1",
    "version": 1,
    "sha256": "完整文件指纹",
    "coordinate_space": "pdf-user-space",
    "pageIndex": 0,
    "positions": [{"pageIndex": 0, "rects": [[50, 700, 300, 720]]}]
  }
}
```

- **文件身份标识**：`side` 取值为 `source`（原文）或 `translation`（译文），通过 `document_id + side + asset_id + version + sha256` 唯一绑定具体 PDF 文件版本。
- **页序约定**：内部 `pageIndex` 从 `0` 开始，界面展示页码为 `pageIndex + 1`。
- **坐标空间**：`pdf-user-space` 采用 PDF 原始用户空间坐标（矩形 `[x1, y1, x2, y2]` 通过 PDF.js viewport 转换，避免受浏览器窗口缩放像素影响），并对照 `manifest.json` 中的 `page_boxes` 校验边界。
- **跨页选区与版本保护**：支持单页或连续跨页选区，`positions` 按页保存矩形列表。当底层 PDF 版本更新后，历史版本的批注仍完整保留文本内容并标注“旧版本”，不会将旧坐标错误绘制到新版本 PDF 上。
- **双侧阅读进度**：`progress.dual_pdf` 分别保存原文侧与译文侧的文件指纹、当前页码、缩放比例与滚动位置，校验文件指纹一致后自动恢复上次阅读位置。

## 接口与测试验证

- 实验接口挂载于 `/experiments/pdf-dual/<id>/`，支持批注持久化与同页引用上下文预览（`context-preview`），前端面板代码位于 `easyread/web/js/pdf-dual/`。
- 运行 `python -m unittest discover -s tests -p test_pdf_dual.py` 可验证文件指纹校验、坐标转换、版本隔离、幂等保存与历史恢复；运行 `node --test tests/test_reflow_outbox.cjs` 可验证前端离线保存队列。
