/* Durable operations use the existing EasyRead /ops contract. One storage key
   per operation prevents two tabs from replacing each other's pending writes. */
(() => {
  'use strict';
  class ReflowOutbox {
    constructor({storage, key, request, changed = () => {}}) {
      Object.assign(this, {storage, prefix:key+':', request, changed});
      this.memory = new Map(); this.flight = null;
    }
    entries() {
      const all = new Map(this.memory);
      for(let i=0;i<this.storage.length;i++) {
        const key=this.storage.key(i);
        if(key?.startsWith(this.prefix)) {
          const value=JSON.parse(this.storage.getItem(key));
          if(!value?.op)throw new Error('待保存记录格式错误，请保留浏览器数据');
          all.set(key,value);
        }
      }
      return [...all].sort((a,b)=>a[1].at.localeCompare(b[1].at)||a[0].localeCompare(b[0]));
    }
    get pending(){return this.entries().length;}
    get volatile(){return [...this.memory.keys()].some(key=>!this.storage.getItem(key));}
    enqueue(op) {
      const key=this.prefix+crypto.randomUUID(), value=structuredClone(op);
      this.memory.set(key,value);
      try {this.storage.setItem(key,JSON.stringify(value));}
      catch(e) {this.changed('error','浏览器存储不可用，修改仅在当前页；请保留页面并重试');throw e;}
      this.changed('pending'); return value;
    }
    flush() {
      if(this.flight)return this.flight;
      this.conflict=false;
      this.flight=this.drain().finally(()=>{this.flight=null;});return this.flight;
    }
    async drain() {
      // Retry memory-only entries after storage becomes available.
      for(const [key,op] of this.memory)this.storage.setItem(key,JSON.stringify(op));
      while(this.pending) {
        const entries=this.entries(), batch=entries.map(([,op])=>op);
        const result=await this.request('/ops',{ops:batch,client:'pdf-reflow'});
        const rejected=batch.filter(op=>!result.applied.includes(op.op==='note'?'note:'+op.note.id:op.op==='note_del'?'note_del:'+op.id:op.op));
        const current=rejected.length?(await this.request('/part/reader')).data:null;
        let conflict=false;
        for(const [key,op] of entries) {
          const label=op.op==='note'?'note:'+op.note.id:op.op==='note_del'?'note_del:'+op.id:op.op;
          const note=current?.notes?.[op.note?.id||op.id];
          const equal=op.op==='note'&&JSON.stringify(note)===JSON.stringify(op.note);
          const deleted=op.op==='note_del'&&note?.deleted&&(note.updated||'')>=op.at;
          if(result.applied.includes(label)||equal||deleted) {this.storage.removeItem(key);this.memory.delete(key);}
          else conflict=true;
        }
        this.changed(this.pending?'pending':'saved');
        if(conflict){this.conflict=true;const error=new Error('笔记版本冲突：修改仍保留在浏览器，请核对原阅读模式中的最新笔记');error.conflict=true;throw error;}
      }
    }
  }
  globalThis.ReflowOutbox=ReflowOutbox;
})();
