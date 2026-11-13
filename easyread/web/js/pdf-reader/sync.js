/* Follow only the other pane. Coalesce fast scrolls; never navigate the source
   pane back to a page top or confuse printed page labels with PDF page indexes. */
(() => {
  class PDFPageSync {
    constructor({assets,enabled,navigate}){Object.assign(this,{assets,enabled,navigate});this.pending=null;this.flight=null;}
    request(side,state){
      this.pending={side,state:{...state}};
      if(!this.flight)this.flight=this.drain().finally(()=>{this.flight=null;});
      return this.flight;
    }
    async drain(){
      while(this.pending){
        const {side,state}=this.pending;this.pending=null;
        const assets=this.assets(),other=side==='source'?'translation':'source';
        if(!this.enabled()||!assets[other]||assets.source.page_count!==assets.translation.page_count)continue;
        const index=state.pageIndex;
        if(!Number.isInteger(index)||index<0||index>=assets[other].page_count)continue;
        const a=assets[side].page_boxes[index],b=assets[other].page_boxes[index],mapped={pageIndex:index};
        if(Number.isFinite(state.top))mapped.top=b[1]+(state.top-a[1])/(a[3]-a[1])*(b[3]-b[1]);
        if(Number.isFinite(state.left))mapped.left=b[0]+(state.left-a[0])/(a[2]-a[0])*(b[2]-b[0]);
        await this.navigate(other,mapped);
      }
    }
  }
  globalThis.PDFPageSync=PDFPageSync;
})();
