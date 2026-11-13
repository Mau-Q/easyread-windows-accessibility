(async()=>{
  'use strict';
  const side=window.frameElement.dataset.side,host=parent.Dual,asset=host.assets[side];
  window.pdfAssetId=asset.id;
  let reader;
  // PDF.js viewport location describes the first visible page. At low zoom,
  // that can be the previous page even after explicit page-number navigation.
  // Keep the logical current page in the toolbar/progress and avoid attaching
  // the previous page's offsets to it.
  const currentState=state=>{
    const number=reader?._primaryView?._iframeWindow?.PDFViewerApplication?.pdfViewer?.currentPageNumber;
    return number && state.pageIndex!==number-1 ? {...state,pageIndex:number-1,top:undefined,left:undefined} : state;
  };
  const noop=()=>{},options={type:'pdf',data:{url:location.origin+asset.url},annotations:[],readOnly:true,colorScheme:'light',lightTheme:'light',darkTheme:'light',
    title:asset.label,authorName:'EasyRead',loggedIn:true,sidebarOpen:false,sidebarWidth:200,sidebarView:'outline',
    showAnnotations:true,primaryViewState:host.initialView(side),onSaveAnnotations:noop,onDeleteAnnotations:noop,
    onChangeViewState:(state,primary)=>{if(primary!==false&&host.assets[side]?.id===asset.id)host.viewChanged(side,currentState(state));},
    onChangeActiveView:()=>{if(host.assets[side]?.id===asset.id)host.activate(side);},onOpenLink:url=>window.open(url,'_blank','noopener'),onConfirm:()=>false,
    onSetDataTransferAnnotations:(transfer,values)=>transfer.setData('text/plain',values.map(v=>v.text).join('\n'))};
  for(const key of ['onOpenTagsPopup','onAddToNote','onToggleSidebar','onChangeSidebarWidth','onChangeSidebarView','onCopyImage','onSaveImageAs','onRotatePages','onDeletePages','onToggleContextPane','onToolbarShiftTab','onIframeTab','onBringReaderToFront','onTextSelectionAnnotationModeChange','onSaveCustomThemes','onSetZoom','onSetReadAloudVoice','onSetReadAloudStatus','onPurchaseReadAloudCredits','onLogIn','onOpenReadAloudFirstRunPopup'])options[key]=noop;
  const shell=document.createElement('style');shell.textContent='.toolbar,#toolbar{display:none!important}#split-view{top:0!important}.primary-view,.secondary-view{top:0!important}.selection-popup{display:none!important}';document.head.append(shell);
  reader=window.createReader(options);window.sampleReader=reader;await reader._primaryView.initializedPromise;
  if(host.annotationClicked)shell.textContent+='.annotation-popup{display:none!important}';
  const view=reader._primaryView,doc=view._iframeWindow.document;
  view._iframe.title=asset.label+' PDF 正文';
  const focusStyle=doc.createElement('style');focusStyle.textContent='.textLayer:focus-visible{outline:3px solid Highlight;outline-offset:-3px}';doc.head.append(focusStyle);
  parent.PDFTextLayer?.install(view._iframeWindow.PDFViewerApplication,view._iframeWindow);
  const getAction=view.getActionAtPosition.bind(view);
  view.getActionAtPosition=(position,event)=>event.button===0&&event.target?.closest?.('.page')&&!event.target.closest('button,input,textarea')?{action:{type:'selectText'},selectAnnotations:[]}:getAction(position,event);
  function capture(){
    const sel=doc.getSelection();if(!sel||sel.isCollapsed||!sel.rangeCount)return null;
    const range=sel.getRangeAt(0),element=n=>n.nodeType===1?n:n.parentElement;
    if(!element(range.startContainer)?.closest('.textLayer')||!element(range.endContainer)?.closest('.textLayer'))return null;
    const quote=range.toString().trim();if(!quote||quote.length>8000)return null;
    const positions=[];
    for(const layer of doc.querySelectorAll('.textLayer')){
      if(!range.intersectsNode(layer))continue;
      const pageIndex=Number(layer.closest('.page').dataset.pageNumber)-1;
      const viewport=view._iframeWindow.PDFViewerApplication.pdfViewer.getPageView(pageIndex)?.viewport;
      const box=layer.getBoundingClientRect();if(!viewport||!box.width||!box.height)continue;
      const walker=doc.createTreeWalker(layer,4),rects=[];let node;
      while((node=walker.nextNode())){
        if(!range.intersectsNode(node))continue;
        const piece=doc.createRange();piece.selectNodeContents(node);
        if(range.compareBoundaryPoints(0,piece)>0)piece.setStart(range.startContainer,range.startOffset);
        if(range.compareBoundaryPoints(2,piece)<0)piece.setEnd(range.endContainer,range.endOffset);
        if(!piece.toString())continue;
        for(const r of piece.getClientRects()){
          if(!r.width||!r.height)continue;
          const a=viewport.convertToPdfPoint((r.left-box.left)*viewport.width/box.width,(r.top-box.top)*viewport.height/box.height),
                b=viewport.convertToPdfPoint((r.right-box.left)*viewport.width/box.width,(r.bottom-box.top)*viewport.height/box.height);
          rects.push([Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])]);
        }
      }
      if(rects.length)positions.push({pageIndex,rects});
    }
    if(!positions.length||positions.length>2)return null;
    return {anchor:`${side}-p${positions[0].pageIndex+1}`,quote,pdf:{schema:1,document_id:parent.PR.pid,coordinate_space:'pdf-user-space',side,asset_id:asset.id,version:asset.version,sha256:asset.sha256,pageIndex:positions[0].pageIndex,positions}};
  }
  let savedRange,dragStart;
  const caret=event=>{
    const r=doc.caretRangeFromPoint?.(event.clientX,event.clientY);
    return r&&r.startContainer.parentElement?.closest('.textLayer')?r:null;
  };
  const snapshot=()=>{const s=doc.getSelection();if(!s?.rangeCount||s.isCollapsed)return null;return s.getRangeAt(0).cloneRange();};
  doc.addEventListener('mousedown',event=>{savedRange=null;dragStart=event.button===0?caret(event):null;host.activate(side);host.clearSelection();},true);
  // Keep CJK mouse drags in the browser's actual text layer when the reader's
  // native character mapper collapses them. Coordinates still come from PDF.js.
  doc.addEventListener('mousemove',event=>{
    if(!dragStart||!(event.buttons&1))return;
    const end=caret(event);if(!end)return;
    doc.getSelection().setBaseAndExtent(dragStart.startContainer,dragStart.startOffset,end.startContainer,end.startOffset);
  },true);
  doc.addEventListener('pointerup',()=>{savedRange=snapshot();},true);
  doc.addEventListener('mouseup',()=>{
    const point=savedRange||snapshot(),position=view.getSelectionPosition(),nativeQuote=(view._selectionRanges||[]).filter(r=>!r.collapsed).sort((a,b)=>a.pageIndex-b.pageIndex).map(r=>r.text).join('\n');
    dragStart=null;setTimeout(()=>{
      if(point&&point.startContainer.isConnected&&point.endContainer.isConnected){
        view._setSelectionRanges();view._render();reader._updateState({primaryViewSelectionPopup:null});
        const sel=doc.getSelection();sel.removeAllRanges();sel.addRange(point);
      }
      let selected=capture();
      if(!selected&&position&&nativeQuote){const positions=[{pageIndex:position.pageIndex,rects:position.rects}];if(position.nextPageRects)positions.push({pageIndex:position.pageIndex+1,rects:position.nextPageRects});selected={anchor:`${side}-p${position.pageIndex+1}`,quote:nativeQuote,pdf:{schema:1,document_id:parent.PR.pid,coordinate_space:'pdf-user-space',side,asset_id:asset.id,version:asset.version,sha256:asset.sha256,pageIndex:position.pageIndex,positions}};}
      if(selected)host.selected(selected);
    },0);
  },true);
  doc.addEventListener('click',event=>{
    if(event.button!==0||snapshot()||!host.annotationClicked)return;
    const layer=event.target.closest('.page')?.querySelector('.textLayer');if(!layer)return;
    const pageIndex=Number(layer.closest('.page').dataset.pageNumber)-1,viewport=view._iframeWindow.PDFViewerApplication.pdfViewer.getPageView(pageIndex)?.viewport,box=layer.getBoundingClientRect();if(!viewport||!box.width||!box.height)return;
    const [x,y]=viewport.convertToPdfPoint((event.clientX-box.left)*viewport.width/box.width,(event.clientY-box.top)*viewport.height/box.height),inner=view._iframe.getBoundingClientRect(),outer=window.frameElement.getBoundingClientRect();
    host.annotationClicked(side,pageIndex,x,y,{left:event.clientX+inner.left+outer.left,top:event.clientY+inner.top+outer.top,bottom:event.clientY+inner.top+outer.top,width:0});
    setTimeout(()=>reader._updateState({selectedAnnotationIDs:[],primaryViewAnnotationPopup:null}),0);
  },true);
  let selectionTimer;
  doc.addEventListener('selectionchange',()=>{
    clearTimeout(selectionTimer);
    selectionTimer=setTimeout(()=>{if(dragStart)return;const selected=capture();if(selected)host.selected(selected);},80);
  });
  doc.addEventListener('keydown',e=>{
    if((e.key==='F10'&&e.shiftKey)||e.key==='ContextMenu'){
      const selected=capture();
      if(selected){e.preventDefault();e.stopImmediatePropagation();host.selected(selected);parent.document.querySelector('#selectionTools button')?.focus();return;}
    }
    if(e.key==='Escape'){doc.getSelection()?.removeAllRanges();host.clearSelection();}else parent.PR.pdfSelectionKeydown?.(e);
  });
  doc.addEventListener('wheel',()=>host.activate(side),{capture:true,passive:true});
  doc.addEventListener('touchstart',()=>host.activate(side),{capture:true,passive:true});
  doc.addEventListener('scroll',()=>host.clearSelection(),{capture:true,passive:true});
  window.capturePDFSelection=capture;
  // Reader.onChangeViewState is debounced by 300ms for persistence. Use PDF.js'
  // per-frame viewport event for visual following; keep the original callback.
  const app=view._iframeWindow.PDFViewerApplication;
  const liveView=event=>{
    const location=event?.location||app.pdfViewer._location;
    if(!location||host.assets[side]?.id!==asset.id)return;
    host.viewChanged(side,currentState({pageIndex:location.pageNumber-1,scale:location.scale,top:location.top,left:location.left}),true);
  };
  app.eventBus.on('updateviewarea',liveView);
  app.eventBus.on('pagechanging',liveView);
  window.addEventListener('unload',()=>{app.eventBus.off('updateviewarea',liveView);app.eventBus.off('pagechanging',liveView);},{once:true});
  liveView();
  await host.paneReady(side,{reader,view,document:doc,capture,assetId:asset.id,liveSync:true});
  parent.PR.readerShell?.attach(doc);
})().catch(e=>{const side=window.frameElement?.dataset.side;if(parent.Dual.assets[side]?.id===window.pdfAssetId)parent.Dual.fail(e);});
