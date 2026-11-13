(() => {
  'use strict';
  const PR=window.PR, $=id=>document.getElementById(id);
  PR.pdfNativeThemes=PR.READER_THEMES.map(t=>({...t,id:'easyread-pdf-'+t.id,invertImages:false}));
  PR.pdfTheme=()=>PR.READER_THEMES.find(t=>t.id===PR.readerThemeValue())||PR.READER_THEMES[0];
  PR.applyPDFTheme=pane=>{
    const theme=PR.pdfTheme(), tone=['dark','black'].includes(theme.id)?'dark':'light', id='easyread-pdf-'+theme.id;
    pane.reader.setCustomThemes(PR.pdfNativeThemes);
    pane.reader.setLightTheme(theme.id==='original'?null:id);
    pane.reader.setDarkTheme(id);pane.reader.setColorScheme(tone);
    for(const doc of [pane.view._container.ownerDocument,pane.document]){
      let style=doc.getElementById('easyread-pdf-surround');
      if(!style){style=doc.createElement('style');style.id='easyread-pdf-surround';doc.head.append(style);}
      style.textContent=`html,body,#mainContainer,#viewerContainer,.pdfViewer,.primary-view,#split-view{background:${theme.background}!important}.pdfViewer .page{background:${theme.background}!important}`;
      doc.documentElement.style.colorScheme=tone;
      PR.readerShell?.attach(doc);
      if(!doc.documentElement.dataset.easyreadControls){
        doc.documentElement.dataset.easyreadControls='true';
        doc.addEventListener('pointerdown',()=>PR.closeReaderThemePicker?.());
        doc.addEventListener('keydown',e=>{if(e.key==='Escape')PR.closeReaderThemePicker?.(true);});
      }
    }
  };
  const apply=()=>{
    const theme=PR.pdfTheme();PR.applyReaderTheme(document,theme.id);
    PR.applyTheme(PR.prefs?.theme || 'auto');
    $('theme').textContent='外观';
    for(const pane of Object.values(window.Dual?.panes||{}))PR.applyPDFTheme(pane);
  };
  PR.on('reader-theme-changed',apply);
  PR.savePrefs=(section,value)=>{
    if(section!=='reader')return;
    const values={};for(const key of ['readerTheme','pen'])if(key in value)values[key]=value[key];if(!Object.keys(values).length)return;
    fetch(PR.readerApi+'/appearance',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json','X-Token':PR.token},body:JSON.stringify(values)})
      .then(r=>{if(!r.ok)throw Error('阅读偏好保存失败');}).catch(e=>window.Dual.fail(e));
  };
  PR.initPDFTheme=appearance=>{const uiTheme=PR.prefs?.theme;PR.prefs={...appearance,theme:uiTheme};apply();fetch('/api/prefs').then(r=>r.json()).then(p=>{PR.prefs.theme=p.reader?.theme||'auto';apply();}).catch(()=>{});};
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change',()=>PR.applyTheme(PR.prefs?.theme||'auto'));
  $('theme').onclick=()=>PR.toggleReaderThemePicker($('theme'));
  PR.showPDFControls=open=>PR.readerShell?.show(open);
})();
