const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
test('PDF Markdown exports side, physical page and immutable version with quote',()=>{
 const n={id:'n1',kind:'note',anchor:'translation-p2',quote:'代码生成',body:'笔记',created:'2026',pdf:{side:'translation',pageIndex:1,version:2}};
 const PR={state:{paper:{meta:{title_en:'Paper'},blocks:[{id:n.anchor,type:'paragraph'}]},reader:{notes:{n1:n}},discussion:{entries:[]}},ls:{get:(k,v)=>v},$:()=>({addEventListener(){}}),myNotes:()=>[n],order:{[n.anchor]:0},debounce:f=>Object.assign(f,{flush(){}}),on(){},plain:x=>x,pdfReferenceLabel:r=>`译文 · 第 ${r.pdf.pageIndex+1} 页 · v${r.pdf.version}`};
 vm.runInNewContext(fs.readFileSync('easyread/web/js/pdf-dual/notespanel.js','utf8'),{window:{PR},setTimeout});
 const md=PR.notesMarkdown();assert.match(md,/译文 · 第 2 页 · v2/);assert.match(md,/「代码生成」：笔记/);assert.doesNotMatch(md,/### 论文开头/);
});
