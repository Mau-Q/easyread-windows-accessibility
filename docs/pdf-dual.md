# 原版式双语 PDF 实验

文献库顶部的“PDF 对照实验”打开独立实验目录。DoReMi 使用已有原文与中文译文，不重排，不翻译。现有文献的“开始阅读”、原 PDF、网页阅读及默认路由保持原行为。

实验文件在项目的 `.pdf-dual-experiments/dual-doremi/`，不属于 `library/`，不进入正式列表。两个 PDF 的副本位于 `assets/`；`manifest.json` 记录版本、指纹、页面边界和页内文字。`reader.json`、`history/reader.log.jsonl`、恢复快照及 `context-previews.json` 都属于该实验。采用现有存储合并、日志和快照规则。

## 批注与引用约定 v1

笔记保留现有 `id/kind/body/anchor/quote/color/created/updated`，增加 `pdf`。问 AI 的每个 `refs[]` 使用相同的 `anchor/quote/pdf` 约定：

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

- `side` 仅为 `source` 或 `translation`。文件身份是 `document_id + side + asset_id + version + sha256`，不能只靠文献 ID 或页码。
- `pageIndex` 从 0 开始。界面显示页码为 `pageIndex + 1`。
- `pdf-user-space` 为 PDF 原始用户坐标；矩形 `[x1,y1,x2,y2]` 沿 PDF 正方向递增。选区通过 PDF.js viewport 转换，不保存浏览器像素坐标。页面边界用 manifest 的 page_boxes 核对。
- 支持单页或连续两页选区。`positions` 保存每页矩形；页笔记和当前页引用的 `positions` 为空。带 `quote` 的选区必须有坐标，且文字可在该 PDF 的对应页确认。
- `native[]` 是 Zotero 显示适配数据，ID 为 `<note id>-<position index>`，位置与 `pdf.positions` 一一对应；不作为另一套批注身份。
- 编辑已有笔记不能改变文件身份或坐标。读到旧版本记录时显示所属版本与“旧版本”，保留内容，不把它绘制到当前 PDF，也不允许旧坐标用于引用预览或覆盖写入。删除仍是保留记录的软删除。
- `progress.dual_pdf` 携带 `schema/document_id/active/sync/panes`；两侧各保存文件身份、页码、缩放和滚动位置。缩放保留 PDF.js location.scale 的约定：适合页宽等命名值，或百分数数值及数值字符串（90 表示 90%，范围 5 至 2000）。Zotero 恢复时将百分数除以 100。文件身份相符才恢复位置。

## 接口与模型边界

所有实验接口位于 `/experiments/pdf-dual/<id>/`，由 CLI 启动时注册的 Handler 子类独立分发。其他请求交还原 Handler。只允许保存操作和引用预览；`chat/translate/import/answer` 等 POST 返回 403，不进入模型或任务队列。前端复用笔记和问 AI 面板的实验适配副本（`web/js/pdf-dual/`），仅在实验页启用引用预览。现有阅读器会把 `server.py`、`store.py` 和共享面板代码纳入默认入口的指纹，因此这些文件保持修改前的精确内容，避免改变已有入口资格。

`context-preview` 先验证每一侧引用，保留选中文字，并返回同一 PDF 页的上下文，标记 `model_called:false`。不生成模型回答。原文和译文目前按相同页码同步，不代表段落语义对齐；滚动和缩放独立。页数不一致的材料不属于本次样例验收。

## 验证

`python -m unittest discover -s tests -p test_pdf_dual.py` 验证身份、坐标、版本替换、原子拒绝、幂等保存、历史恢复和实验接口隔离。`node --test tests/test_reflow_outbox.cjs` 验证浏览器保存队列。实际桌面窗口还需验证两侧真实拖选、关闭重开、定位和混合引用。
