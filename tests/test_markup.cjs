// Markdown 表格边界；实际公式与布局由浏览器回归检查。
const fs = require('fs'), vm = require('vm'), assert = require('assert/strict');
const PR = { esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
vm.runInNewContext(fs.readFileSync(require('path').join(__dirname, '../easyread/web/js/common/markup.js'), 'utf8'), {
  window: { PR }, katex: { renderToString: s => '<span class="katex">' + PR.esc(s) + '</span>' }
});
const tests = [
  ['中文表格与公式', '| 名称 | 用途 |\n| --- | --- |\n| 训练 | 更新 $\\theta$ |\n| 验证 | 选择 $\\mathbf{w}$ |', h => (h.match(/<tr>/g) || []).length === 3 && h.includes('class="katex"')],
  ['列对齐与无外侧竖线', '左 | 中 | 右\n:--- | :---: | ---:\n甲 | 乙 | 丙', h => h.includes('md-align-left') && h.includes('md-align-center') && h.includes('md-align-right')],
  ['转义竖线与代码', '| A | B |\n| --- | --- |\n| a\\|b | `x|y` |', h => h.includes('a|b') && h.includes('<code>x|y</code>') && (h.match(/<td /g) || []).length === 2],
  ['公式竖线不拆列且保留 TeX', '| A | B |\n| --- | --- |\n| $|x|$ | $\\|w\\|_2$ |', h => h.includes('\\|w\\|_2') && (h.match(/<td /g) || []).length === 2],
  ['代码围栏不当作表格', '```md\n| A | B |\n| --- | --- |\n| <script> | x |\n```', h => h.startsWith('<pre><code>') && !h.includes('<table') && h.includes('&lt;script&gt;')],
  ['未完成流式分隔行保留', '| A | B |\n| --- | --', h => !h.includes('<table') && h.includes('| --- | --')],
  ['未完成流式表格行保留', '| A | B |\n| --- | --- |\n| done | row |\n| pending', h => h.includes('<table') && h.includes('<p>| pending</p>')],
  ['表格前后正文和 HTML 安全', '前文\n\n| A | B |\n| --- | --- |\n| <img src=x> | value |\n\n后文', h => h.startsWith('<p>前文</p>') && h.endsWith('<p>后文</p>') && !h.includes('<img')],
  ['括号行内公式与表格', String.raw`| 比例 | 说明 |
| --- | --- |
| \(1/4\) | 样本 |
| \(1/256\) | 少量 |`, h => (h.match(/class="katex"/g) || []).length === 2 && !h.includes('\\(')],
  ['方括号多段行间公式', String.raw`可以把比较关系写成：

\[

\text{混合收益}=\text{Mixed 得分}-

\text{Individual 得分}

\]

后文`, h => h.includes('<div class="eq">') && (h.match(/class="katex"/g) || []).length === 1 && !h.includes('\\[') && h.endsWith('<p>后文</p>')],
  ['括号公式中的竖线不拆列', String.raw`| A | B |
| --- | --- |
| \(\|x\|+|y|\) | 值 |`, h => (h.match(/<td /g) || []).length === 2 && h.includes('\\|x\\|+|y|')],
  ['代码中的公式保持字面值', '代码：`\\(x\\)` 和 `$y$`\n\n```tex\n\\[z\\]\n```', h => !h.includes('class="katex"') && h.includes('<code>\\(x\\)</code>') && h.includes('\\[z\\]')],
  ['未闭合括号公式保留流式正文', String.raw`计算 \(x+1 和后文`, h => !h.includes('class="katex"') && h.includes('\\(x+1')],

];
for (const [name, source, check] of tests) { assert(check(PR.mdBlocks(source)), name); console.log('PASS', name); }
