/* LaTeXiT embeds an editable equation archive as microscopic PDF text. It is
   not visible paper text; keep the PDF bytes untouched and omit only these
   explicit metadata strings from the reader's text extraction and layout. */
(() => {
  'use strict';
  const installed=new WeakSet(),pages=new WeakSet();
  function isMetadata(item){
    if(typeof item.str!=='string'||!Array.isArray(item.transform))return false;
    const size=Math.max(Math.hypot(item.transform[0],item.transform[1]),Math.hypot(item.transform[2],item.transform[3]));
    return size<0.001&&/^\s*(?:<\/?latexit\b|sha1_base64\s*=)/i.test(item.str);
  }
  const clean=content=>({...content,items:content.items.filter(item=>!isMetadata(item))});
  function install(app,win){
    const doc=app.pdfDocument;if(!doc||installed.has(doc))return;installed.add(doc);
    function patch(page){
      if(pages.has(page))return page;pages.add(page);
      const get=page.getTextContent,stream=page.streamTextContent;
      page.getTextContent=async function(...args){return clean(await get.apply(this,args));};
      page.streamTextContent=function(...args){return stream.apply(this,args).pipeThrough(new win.TransformStream({transform(chunk,controller){controller.enqueue(clean(chunk));}}));};
      return page;
    }
    const getPage=doc.getPage;
    doc.getPage=async function(...args){return patch(await getPage.apply(this,args));};
    for(const view of app.pdfViewer._pages||[])if(view.pdfPage)patch(view.pdfPage);
  }
  globalThis.PDFTextLayer={isMetadata,clean,install};
})();
