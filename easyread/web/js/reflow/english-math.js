'use strict';
// All substitutions require a frozen PDF font/position match. SDT is immutable.
window.mountEnglishMath=(view,structure,evidence,observations)=>{
  const doc=view._iframeDocument,data=new Map(),textTokens=new WeakMap();
  const find=ref=>doc.querySelector('[data-ref-path="'+ref[0]+'"] [data-text-index="'+ref[1]+'"]');
  const reordered={
    '25.7':[['αa\u0304 nd',[0,2,null,1,4,5]]],
    '30.15':[['α=\u0304',[0,2,null,1]]],
    '31.0':[['αd\u0304 efine',[0,2,null,1,4,5,6,7,8]]],
    '37.3':[['αf\u0304 rom',[0,2,null,1,4,5,6]],['α−\u0304 α',[0,2,null,1,3,4]]]
  };
  const style=doc.createElement('style');style.textContent='.pilot-en-italic{font-family:KaTeX_Math,serif;font-style:italic}.pilot-en-roman{font-family:KaTeX_Main,serif;font-style:normal}.pilot-en-accent,.pilot-en-hat{display:inline-block;position:relative;width:0;vertical-align:baseline}.pilot-en-accent>span,.pilot-en-hat>span{font-size:0}.pilot-en-accent:after{content:"";position:absolute;left:-.56em;top:-.73em;width:.49em;border-top:1px solid currentColor;pointer-events:none}.pilot-en-hat:after{content:"ˆ";font-family:KaTeX_Main,serif;font-style:normal;position:absolute;left:-.53em;top:-1em;line-height:1;pointer-events:none}';doc.head.append(style);
  for(const entry of evidence.nodes){
    const ref=entry.ref,key=ref.join('.'),raw=structure.content[ref[0]].content[ref[1]].text;
    if(raw!==entry.raw_text)throw new Error('数学来源版本不匹配：'+key);
    const span=find(ref);if(!span||span.closest('[hidden]'))continue;
    const walker=doc.createTreeWalker(span,4),text=[];while(walker.nextNode())text.push(walker.currentNode);
    if(text.length!==1)throw new Error('数学字体修复遇到未知文本结构：'+key);
    const original=text[0],shown=original.data,map=view._pilotOffsetMaps.get(key),glyphs=new Map(entry.glyphs.map(g=>[g.raw_index,g]));
    let tokens=[...shown].map((char,i)=>{const a=map?.displayToRaw[i]??i,b=map?.displayToRaw[i+1]??i+1,rawIndex=b>a?a:null,g=rawIndex===null?null:glyphs.get(rawIndex);return{char:g?.replacement||char,rawIndex,g};});
    for(const [pattern,order] of reordered[key]||[]){
      const at=raw.indexOf(pattern);if(at<0)throw new Error('重音来源文字不匹配：'+key);
      const accent=glyphs.get(at+pattern.indexOf('\u0304'));if(accent?.pdf_char!=='¯')throw new Error('重音没有原 PDF 证据：'+key);
      const first=tokens.findIndex(t=>t.rawIndex===at),last=tokens.findIndex(t=>t.rawIndex===at+pattern.length-1);
      const chosen=order.map(i=>i===null?{char:' ',rawIndex:null,g:null}:tokens.find(t=>t.rawIndex===at+i));
      tokens.splice(first,last-first+1,...chosen);
      observations.corrections.push({ref:key,basis:'PDF-overbar-coordinate-and-reading-order',before:pattern,after:chosen.map(t=>t.char).join(''),source_index_order:chosen.map(t=>t.rawIndex)});
    }
    const frag=doc.createDocumentFragment();let group=[];
    const flush=()=>{if(!group.length)return;const accent=group[0].char==='\u0304'&&group[0].g?.pdf_char==='¯',hat=group[0].char==='\u0302'&&group[0].g?.pdf_char==='ˆ';const el=doc.createElement('span');if(accent)el.className='pilot-en-accent';else if(hat)el.className='pilot-en-hat';else if(group[0].g)el.className='pilot-en-'+group[0].g.font_role;
      const n=doc.createTextNode(group.map(t=>t.char).join(''));if(accent||hat){const zero=doc.createElement('span');zero.append(n);el.append(zero);}else el.append(n);
      group.forEach((t,i)=>{t.node=n;t.offset=i;});textTokens.set(n,group);frag.append(el);group=[];};
    const kind=t=>t.char==='\u0304'&&t.g?.pdf_char==='¯'?'accent':t.char==='\u0302'&&t.g?.pdf_char==='ˆ'?'hat':t.g?.font_role||'prose';
    for(const t of tokens){const k=kind(t),prev=group.at(-1),prior=prev&&kind(prev);if(prior&&prior!==k)flush();group.push(t);}flush();original.replaceWith(frag);
    data.set(key,{span,ref,tokens,raw});
  }
  // Two subscript overbars were emitted after punctuation by the parser.
  const layoutStyle=doc.createElement('style');layoutStyle.textContent='.pilot-en-operator{font-family:KaTeX_Size1,serif;font-style:normal}.pilot-mathml-sum,.pilot-mathml-frac{font-size:1em;margin:0 .05em}';doc.head.append(layoutStyle);
  const M=name=>doc.createElementNS('http://www.w3.org/1998/Math/MathML',name);
  const mathToken=t=>{const el=M(t.rawIndex===null?'mtext':/\d/.test(t.char)?'mn':/[A-Za-zαθ]/.test(t.char)?'mi':'mo');if(t.rawIndex===null)el.style.fontSize='0';if(el.localName==='mo')el.setAttribute('stretchy','false');const n=doc.createTextNode(t.char);el.append(n);t.node=n;t.offset=0;return el;};
  const rowFor=entry=>{const row=M('mrow');row.dataset.textIndex=entry.ref[1];for(const t of entry.tokens)row.append(mathToken(t));entry.span=row;return row;};
  const shell=className=>{const math=M('math');math.classList.add(className);math.style.fontSize='1em';return math;};
  const fraction=data.get('24.19'),fractionAt=fraction.raw.indexOf('1 |D|');
  if(fractionAt<0)throw new Error('分式原文不匹配');
  const fracTokens=[0,2,3,4].map(i=>fraction.tokens.find(t=>t.rawIndex===fractionAt+i));
  const fr=doc.createRange();fr.setStart(fracTokens[0].node,fracTokens[0].offset);fr.setEnd(fracTokens.at(-1).node,fracTokens.at(-1).offset+1);fr.deleteContents();
  const frac=shell('pilot-mathml-frac'),mfrac=M('mfrac'),top=M('mrow'),bottom=M('mrow'),slash={char:'/',rawIndex:null,g:null};top.append(mathToken(fracTokens[0]),mathToken(slash));for(const t of fracTokens.slice(1))bottom.append(mathToken(t));mfrac.append(top,bottom);frac.append(mfrac);fr.insertNode(frac);
  const fstart=fraction.tokens.findIndex(t=>t.rawIndex===fractionAt),fend=fraction.tokens.findIndex(t=>t.rawIndex===fractionAt+4);fraction.tokens.splice(fstart,fend-fstart+1,fracTokens[0],slash,...fracTokens.slice(1));
  const numerator=find([30,17]),denominator=find([30,19]),frac2=shell('pilot-mathml-frac'),mf2=M('mfrac');numerator.before(frac2);const numerData=data.get('30.17'),slash2={char:'/',rawIndex:null,g:null};numerData.tokens.push(slash2);mf2.append(rowFor(numerData),rowFor(data.get('30.19')));frac2.append(mf2);numerator.remove();denominator.remove();find([30,18]).hidden=true;
  const sumLayouts=[{sign:[24,10],upperIndex:1,lower:[24,12]},{sign:[24,19],lower:[24,21],embedded:true},{sign:[30,21],upper:[30,22],lower:[30,24]},{sign:[167,5],lower:[167,7]},{sign:[180,7],lower:[180,9]}];
  for(const spec of sumLayouts){const entry=data.get(spec.sign.join('.')),sum=entry.tokens.find(t=>t.char==='∑');if(sum?.g?.basis!=='embedded-font-code-80-summationtext')throw new Error('求和没有字体/坐标证据');
    const math=shell('pilot-mathml-sum'),operator=M(spec.upper||spec.upperIndex!==undefined?'munderover':'munder'),sign=mathToken(sum),oldSource=entry.span,oldLower=find(spec.lower),lowerData=data.get(spec.lower.join('.'));operator.append(sign,rowFor(lowerData));
    if(spec.upperIndex!==undefined){const upper=M('mrow');upper.append(mathToken(entry.tokens.find(t=>t.rawIndex===spec.upperIndex)));operator.append(upper);}
    if(spec.upper){const oldUpper=find(spec.upper);operator.append(rowFor(data.get(spec.upper.join('.'))));oldUpper.remove();}
    if(spec.embedded){const placeholder=[...oldSource.querySelectorAll('.pilot-en-operator')].find(el=>el.textContent==='∑');if(!placeholder)throw new Error('求和显示来源不匹配');math.append(operator);placeholder.replaceWith(math);}
    else{const source=M('mrow');source.dataset.textIndex=entry.ref[1];source.append(operator);math.append(source);oldSource.replaceWith(math);entry.span=source;}
    oldLower.remove();
    const li=spec.lower[1];for(let i=spec.sign[1]+1;i<li;i++){const space=find([spec.sign[0],i]);if(space&&/^\s*$/.test(space.textContent))space.hidden=true;}
  }
  const overrides=new Map();for(const entry of evidence.nodes)for(const g of entry.glyphs)if(g.pdf_rect)overrides.set(entry.ref.join('.')+':'+g.raw_index,g.pdf_rect);view._pilotPDFRunOverrides=overrides;
  observations.corrections.push({basis:'source-font-and-source-PDF-reviewed-inline-expression-layout',sums:5,fractions:2});
  for(const [accentRef,beforeRef] of [[[25,10],[25,9]],[[31,3],[31,2]]]){
    const a=find(accentRef),b=find(beforeRef);if(!a||!b)continue;
    if(a.textContent!=='\u0304'||b.textContent!=='.')throw new Error('下标重音结构不匹配');b.before(a);
    observations.corrections.push({ref:accentRef,basis:'PDF-subscript-overbar-before-punctuation',display_order:[accentRef,beforeRef]});
  }
  const point=view._pointToDOMPosition.bind(view);
  view._pointToDOMPosition=p=>{const e=data.get(p.slice(0,-1).join('.'));if(!e)return point(p);const t=e.tokens.find(t=>t.rawIndex===p.at(-1));if(t)return{node:t.node,offset:t.offset};const last=e.tokens.at(-1);return{node:last.node,offset:last.offset+last.char.length};};
  const rawRanges=(ref,start,end)=>{
    const e=data.get(ref.join('.'));if(!e)return null;const ranges=[];let group=[];
    const flush=()=>{if(!group.length)return;const r=doc.createRange(),a=group[0],b=group.at(-1);r.setStart(a.node,a.offset);r.setEnd(b.node,b.offset+b.char.length);ranges.push(r);group=[];};
    for(const t of e.tokens){if(t.rawIndex!==null&&t.rawIndex>=start&&t.rawIndex<end){const previous=group.at(-1);if(previous&&(previous.node!==t.node||previous.offset+previous.char.length!==t.offset))flush();group.push(t);}else flush();}flush();return ranges;
  };
  const selectionParts=(span,range)=>{
    const key=span.closest('[data-ref-path]').dataset.refPath+'.'+span.dataset.textIndex,e=data.get(key);if(!e)return null;
    const selected=e.tokens.filter(t=>range.intersectsNode(t.node)&&!(range.startContainer===t.node&&t.offset+t.char.length<=range.startOffset)&&!(range.endContainer===t.node&&t.offset>=range.endOffset));
    const quote=selected.map(t=>t.char).join(''),parts=[];
    for(const t of selected){if(t.rawIndex===null)continue;const prev=parts.at(-1);if(prev&&prev.end===t.rawIndex)prev.end=t.rawIndex+1;else parts.push({start:t.rawIndex,end:t.rawIndex+1});}
    return {quote,parts,ref:e.ref};
  };
  view._pilotRawRanges=rawRanges;view._pilotMathSelection=selectionParts;view._pilotMathData=data;
  observations.englishMath={fontMatchedGlyphs:evidence.nodes.reduce((n,e)=>n+e.glyphs.length,0),lossSymbolRepairs:evidence.nodes.reduce((n,e)=>n+e.glyphs.filter(g=>g.raw==='`'&&g.replacement).length,0),unverified:evidence.unresolved};
};
