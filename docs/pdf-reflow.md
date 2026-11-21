# PDF 结构化重排与双语阅读

## 阅读导向的结构化重排流程

`pdf_pipeline` 默认采用 `pdf_review_profile="reading"` 模式：复用已有中文译文、保留原始结构化文档树（SDT）正文与选区坐标，对译文做原页语义核对，参考文献保持英文原文，并将核对结果按内容指纹缓存。

- **公式与图表保真**：普通正文采用自适应网页排版；紧接图注的图内标签直接展示原图区域与中文题注；已有译文中的行间公式通过 `display_math` 用 KaTeX 精确排版，保持字符与批注偏移量不变。
- **核对提示**：对于存在歧义的复杂段落，界面自动标注“需对照原文”并提供一键跳转原 PDF 对应位置的链接。
- **入口切换**：已生成结构化重排包的文献可通过 `/read/<id>?source=pdf&mode=reflow` 进入双语重排阅读，也可随时切换回原版式 PDF 阅读模式。重排缓存存放在数据目录 `.pdf-reflow/<sha256>/` 下，并通过 `cache-proof.json` 校验原 PDF 与缓存文件的 SHA-256 一致性。

## 批注、进度与离线保存队列

- **批注与高亮**：新增划线与笔记通过 `/ops` 接口写入 `reader.json`，同时记录语言侧别（`language`）、来源指纹与原 PDF 坐标范围，支持笔记编辑、改色与二次确认删除。
- **阅读进度恢复**：同时保存段落偏移量（`block/ratio/offset`）与绑定 PDF 指纹的页码，重新打开时自动恢复到上次阅读的精确段落或页码，并支持在点击引用跳转后按 `Alt+Left`（或点击“返回阅读位置”）回到原阅读处。
- **本地队列防丢**：所有批注与笔记修改在发送前先写入浏览器 `localStorage` 独立队列，待服务端确认落盘后移除；遇到网络中断或服务重启时自动补发或提示重试。

## 结构化重排包生成命令

在已构建上游 `document-worker` 的环境下，可通过以下命令为指定文献生成结构化重排包：

```sh
python -m easyread.reflow_prepare --workspace /path/to/library/paper_id \
  --worker-root /path/to/document-worker --out /path/to/output_dir
```

该流程在文献目录外独立运行，校验前后文件哈希不变，并将段落映射结果输出至 `full-mapping.json` 与 `cache-proof.json`。添加 `--install-preview` 参数可将生成的重排包安装至本地预览目录。

## 上游组件与开源许可

前端内置的重排阅读器资源位于 `easyread/web/vendor/zotero/`，对应上游 [zotero/reader](https://github.com/zotero/reader) 提交 `4bfd82ee848e36e80aaff2a2c732615c89ad1e72` 及 `document-worker` 提交 `9d11471391fc3f609a0d1e7012b82b9be6ca9c12`。Zotero Reader 采用 AGPL-3.0 许可证（随目录保留 `COPYING`），其依赖的 PDF.js、MathJax 与 KaTeX 均保留各自原始开源许可证声明，项目适配层代码位于 `easyread/web/js/reflow/`。
