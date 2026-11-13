(() => {
  'use strict';
  const $=id=>document.getElementById(id),api=PR.readerApi;
  const key='easyread-pdf-translation:'+PR.routePid;
  let loading=false,models=[],timer,flight,again=false,delay=1500;
  const request=async(path,body)=>{
    const r=await PR.chatFetch(api+'/translation'+path,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-Token':PR.token},body:JSON.stringify(body)});
    const d=await r.json();if(!r.ok)throw Error(d.error||'翻译请求失败');return d;
  };
  function refresh(){
    clearTimeout(timer);
    if(document.hidden)return Promise.resolve();
    if(flight){again=true;return flight;}
    flight=refreshState().finally(()=>{flight=null;if(!document.hidden)timer=setTimeout(refresh,again?0:delay);again=false;});
    return flight;
  }
  async function refreshState(){
    try{
      if(!window.dualReady)return;
      const d=await request(''),t=d.task||{};models=d.models||[];
      const busy=['queued','running','cancelling'].includes(t.state);
      delay=busy?1500:30000;
      $('nativeTranslationStatus').textContent=t.state==='idle'?'用幻觉翻译生成中文 PDF':(t.message||t.state)+' · '+(t.model||'');
      $('nativeTranslate').disabled=busy||!models.length;
      $('translatePending').disabled=busy||!models.length;
      if(!models.length&&t.state==='idle')$('nativeTranslationStatus').textContent='请先在幻觉翻译中启用一个模型连接';
      $('nativeTranslate').textContent=busy?'翻译中':t.state==='failed'||t.state==='cancelled'?'重新启动翻译':Dual.assets.translation?'重新翻译':'用幻觉翻译';
      $('nativeCancel').hidden=!busy;
      if(busy&&!localStorage.getItem(key))localStorage.setItem(key,t.id);
      if(t.state==='completed'&&localStorage.getItem(key)===t.id&&!loading){
        loading=true;
        try{
          await Dual.selectTranslation(t.asset_id);
          localStorage.removeItem(key);
        }catch(e){loading=false;throw e;}
      }
    }catch(e){$('nativeTranslationStatus').textContent=e.message;delay=Math.min(60000,Math.max(3000,delay*2));}
  }
  $('nativeTranslate').onclick=()=>{
    const dlg=$('nativeTranslationDialog');
    $('nativeModel').replaceChildren(...models.map(m=>{const o=document.createElement('option');o.value=m.id;o.textContent=m.model+' · '+m.base_url;return o;}));
    dlg.showModal();
  };
  $('translatePending').onclick=()=>$('nativeTranslate').onclick();
  $('nativeStart').onclick=async()=>{
    $('nativeStart').disabled=true;
    try{
      PR.flushNotesPanelEdits?.();await PR.flush();
      const d=await request('/start',{model_id:$('nativeModel').value});
      localStorage.setItem(key,d.task.id);$('nativeTranslationDialog').close();await refresh();
    }catch(e){$('nativeTranslationError').textContent=e.message;}
    finally{$('nativeStart').disabled=false;}
  };
  $('nativeDismiss').onclick=()=>$('nativeTranslationDialog').close();
  $('nativeCancel').onclick=async()=>{try{await request('/cancel',{});await refresh();}catch(e){$('nativeTranslationStatus').textContent=e.message;}};
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else refresh();});
  window.addEventListener('focus',()=>{if(!document.hidden)refresh();});
  refresh();
})();
