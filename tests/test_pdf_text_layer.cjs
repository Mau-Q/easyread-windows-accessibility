const {test}=require('node:test');const assert=require('node:assert/strict');require('../easyread/web/js/pdf-reader/text-layer.js');
const item=(str,size)=>({str,transform:[size,0,0,size,10,10],width:10,height:size});
test('removes only microscopic LaTeXiT metadata and preserves paper text',()=>{
 const hidden=item('sha1_base64="abc">archive</latexit>',1e-7),visible=item('<latexit example>',12),tinyFormula=item('x',1e-7),body=item('数据选择',12),marker={type:'beginMarkedContent'};
 const raw={items:[hidden,visible,tinyFormula,body,marker],styles:{font:{}},lang:'zh'};const clean=PDFTextLayer.clean(raw);
 assert.deepEqual(clean.items,[visible,tinyFormula,body,marker]);assert.equal(raw.items.length,5);assert.equal(clean.styles,raw.styles);assert.equal(clean.lang,'zh');
});
test('both promise and stream extraction preserve options and are idempotently installed',async()=>{
 const raw={items:[item('<latexit',1e-7),item('visible equation',10)],styles:{}};let request;
 const page={streamTextContent(options){request=options;return new ReadableStream({start(c){c.enqueue(raw);c.close();}});},async getTextContent(options){request=options;return raw;}};
 const doc={async getPage(){return page;}};const app={pdfDocument:doc,pdfViewer:{_pages:[{pdfPage:page}]}};
 PDFTextLayer.install(app,{TransformStream});const patched=page.getTextContent;PDFTextLayer.install(app,{TransformStream});assert.equal(page.getTextContent,patched);
 const options={disableNormalization:true};assert.deepEqual((await page.getTextContent(options)).items,[raw.items[1]]);assert.equal(request,options);
 const chunk=await page.streamTextContent(options).getReader().read();assert.deepEqual(chunk.value.items,[raw.items[1]]);assert.equal(request,options);assert.equal(await doc.getPage(1),page);
});
