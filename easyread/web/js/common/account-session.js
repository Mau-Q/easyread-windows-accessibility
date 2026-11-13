/* Account and consent additions to the existing App; no alternate product mode. */
(()=>{'use strict';const account=window.EASYREAD_ACCOUNT;if(!account)return;const PR=window.PR;PR.account=account;PR.token=account.csrf;
const nativeFetch=window.fetch.bind(window);const local=PR.ls,prefix='account:'+account.username+':';PR.ls={get:(k,d)=>local.get(prefix+k,d),set:(k,v)=>local.set(prefix+k,v),del:k=>local.del(prefix+k)};
const changed=()=>{window.EasyReadAccount?.allowNavigation?.();document.body.replaceChildren();location.replace('/login');};
window.fetch=async(input,options={})=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href);if(url.origin!==location.origin)return nativeFetch(input,options);
 const headers=new Headers(options.headers||{});if((options.method||'GET')!=='GET'){headers.set('X-CSRF',account.csrf);headers.set('X-EasyRead','app');}
 const send=()=>nativeFetch(input,{...options,headers,cache:'no-store'});let response=await send();const bound=response.headers.get('X-EasyRead-Session');
 if(response.status===401||(bound&&bound!==account.csrf)){changed();throw Error('登录状态已改变，请重新登录');}
 if(response.status===403){const challenge=await response.clone().json().catch(()=>({}));if(challenge.code==='consent_required'){
  const info=challenge.info;const accepted=await PR.confirm({title:'AI调用前的说明',body:`服务：${info.service}\n模型：${info.model}\n发送范围：${info.description}\n\n${info.fee}\n${info.privacy}\n\n同意限本次登录、同一服务和已说明范围；拒绝后仍可本地阅读与记笔记。`,ok:'同意并继续',cancel:'暂不调用'});
  if(!accepted)throw Error('未同意AI调用，本地功能仍可使用');
  const saved=await nativeFetch('/api/consent',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF':account.csrf,'X-EasyRead':'app'},body:JSON.stringify({scope:challenge.scope,model:challenge.model,fingerprint:info.fingerprint})});
  if(!saved.ok)throw Error((await saved.json()).error||'同意未保存');response=await send();
 }}return response;
};
window.EasyReadAccount={async api(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error||'读取或保存失败');return d;},async logout(){if(this.mayLeave&&!await this.mayLeave())return;await this.api('/api/logout',{});this.allowNavigation?.();changed();}};
const key='easyread-account-owner';if(sessionStorage.getItem(key)!==account.username){sessionStorage.removeItem('easyread-library-return-v1');sessionStorage.setItem(key,account.username);}
document.addEventListener('DOMContentLoaded',()=>{const bar=document.querySelector('.topbar')||document.getElementById('readerBar');if(!bar)return;const button=document.createElement('button');button.className='btn account-account';button.textContent=account.username+' · 退出';button.onclick=()=>EasyReadAccount.logout().catch(e=>PR.toast(PR.esc(e.message)));bar.append(button);});
setInterval(()=>EasyReadAccount.api('/api/session').catch(()=>{}),2500);
})();
