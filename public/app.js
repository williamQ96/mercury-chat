/* Only the non-secret language preference persists. Keys and chats never do. */
import { translations } from '/i18n.mjs';
const $ = id => document.getElementById(id);
let csrf = '', hasKey = false, busy = false, generation = 0, activeId = null;
let messages = [], controller = null;
let language = 'en', connectionState = 'missing', noticeKey = '';
try { if (localStorage.getItem('mercury-chat-language') === 'zh') language = 'zh'; } catch {}
const t = key => key.split('.').reduce((value,part)=>value?.[part],translations[language]) || translations.en.errors.internal;
function setStatus(state) { connectionState=state; $('status').textContent=t('status.'+state); $('status').dataset.state=state; }
function notify(key='') { noticeKey=key; $('notice').textContent=key?t(key):''; $('notice').hidden=!key; }
function applyLanguage(value, persist=false) {
  language=value==='zh'?'zh':'en'; document.documentElement.lang=language==='zh'?'zh-CN':'en'; document.title='mercury chat'; $('language').value=language;
  if(persist)try{localStorage.setItem('mercury-chat-language',language);}catch{}
  document.querySelectorAll('[data-i18n]').forEach(el=>{el.textContent=t(el.dataset.i18n);});
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>{el.placeholder=t(el.dataset.i18nPlaceholder);});
  document.querySelectorAll('[data-i18n-aria]').forEach(el=>{el.setAttribute('aria-label',t(el.dataset.i18nAria));});
  setStatus(connectionState); notify(noticeKey); update();
}
function update() {
  $('send').disabled = busy || !hasKey || !$('prompt').value.trim();
  $('send').hidden = busy; $('stop').hidden = !busy;
  $('saveKey').disabled = busy; $('check').disabled = busy || !hasKey; $('forget').disabled = busy || !hasKey;
  $('hint').textContent = t(busy ? 'waitingHint' : 'keyboardHint');
}
async function api(path, data, signal) {
  const response = await fetch(path, {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,'X-Language':language}, body:JSON.stringify(data), signal});
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error?.message || translations.en.errors.internal); error.code = result.error?.code; throw error; }
  return result;
}
function handleError(error) {
  if (error.name === 'AbortError' || error.code === 'cancelled') return;
  const states = {unauthorized:'unauthorized',unreachable:'unreachable',timeout:'timeout',upstream_error:'error',empty:'error',model:'error',session_expired:'missing',missing_key:'missing'};
  if (states[error.code]) setStatus(states[error.code]);
  if (error.code === 'session_expired' || error.code === 'missing_key') hasKey = false;
  notify(error.code && translations[language].errors[error.code] ? 'errors.'+error.code : 'localUnavailable');
}
// Markdown subset built exclusively with text nodes and fixed element names.
function inline(parent, text) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let offset = 0;
  for (const m of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(offset,m.index)));
    const tag = m[0].startsWith('`') ? 'code' : m[0].startsWith('**') ? 'strong' : 'em';
    const el = document.createElement(tag), edge = tag === 'strong' ? 2 : 1;
    el.textContent = m[0].slice(edge,-edge); parent.append(el); offset=m.index+m[0].length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}
function markdown(parent, text) {
  const lines = text.split('\n'); let fence = false, code = [], paragraph = [], list = null;
  const flush = () => { if (paragraph.length) { const p=document.createElement('p'); inline(p,paragraph.join('\n')); p.style.whiteSpace='pre-wrap'; parent.append(p); paragraph=[]; } };
  const flushCode = () => { const pre=document.createElement('pre'), c=document.createElement('code'); c.textContent=code.join('\n'); pre.append(c); parent.append(pre); code=[]; };
  for (const line of lines) {
    if (/^\s*```/.test(line)) { flush(); list=null; if(fence) flushCode(); fence=!fence; continue; }
    if(fence) {code.push(line);continue;}
    if(!line.trim()) {flush();list=null;continue;}
    const heading=line.match(/^#{1,6}\s+(.+)$/), item=line.match(/^\s*(?:([-*])|(\d+)\.)\s+(.+)$/);
    if(heading){flush();list=null;const h=document.createElement('h3');inline(h,heading[1]);parent.append(h);}
    else if(item){flush();const tag=item[2]?'ol':'ul';if(!list||list.tagName.toLowerCase()!==tag){list=document.createElement(tag);parent.append(list);}const li=document.createElement('li');inline(li,item[3]);list.append(li);}
    else {list=null;paragraph.push(line);}
  }
  if(fence) flushCode(); flush();
}
function appendMessage(role, text, pending=false) {
  $('welcome').hidden=true;
  const row=document.createElement('article');row.className=`message ${role}`;
  const avatar=document.createElement('span');avatar.className='avatar';avatar.textContent=role==='user'?t('youAvatar'):'M';if(role==='user')avatar.dataset.i18n='youAvatar';
  const content=document.createElement('div');content.className='message-content';
  const speaker=document.createElement('p');speaker.className='speaker';speaker.textContent=role==='user'?t('you'):'mercury chat';if(role==='user')speaker.dataset.i18n='you';
  const bubble=document.createElement('div');bubble.className='bubble';
  if(pending){const p=document.createElement('p');p.className='pending';p.textContent=t('thinking');p.dataset.i18n='thinking';bubble.append(p);}
  else if(role==='user'){bubble.classList.add('user-text');bubble.textContent=text;}
  else markdown(bubble,text);
  content.append(speaker,bubble);row.append(avatar,content);$('messages').append(row);$('messages').scrollTop=$('messages').scrollHeight;
  return row;
}
function resize(){ $('prompt').style.height='auto';$('prompt').style.height=Math.min(190,$('prompt').scrollHeight)+'px';update(); }
$('prompt').addEventListener('input',resize);
$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('chatForm').requestSubmit();}});
document.querySelectorAll('[data-prompt-key]').forEach(b=>b.addEventListener('click',()=>{$('prompt').value=t(b.dataset.promptKey);resize();$('prompt').focus();}));
$('keyForm').addEventListener('submit',async e=>{
  e.preventDefault();if(busy)return; const data={key:$('apiKey').value.trim()};$('apiKey').value='';
  busy=true;update();notify();
  try{const result=await api('/api/key',data);data.key='';hasKey=result.hasKey;setStatus(result.connection);}
  catch(error){handleError(error);}finally{data.key='';busy=false;update();}
});
$('check').addEventListener('click',async()=>{
  if(busy||!hasKey)return;busy=true;activeId=crypto.randomUUID();controller=new AbortController();const epoch=generation;update();notify();
  try{const result=await api('/api/check',{id:activeId},controller.signal);if(epoch===generation)setStatus(result.connection);}
  catch(error){if(epoch===generation)handleError(error);}finally{if(epoch===generation){busy=false;activeId=null;controller=null;update();}}
});
$('forget').addEventListener('click',async()=>{
  if(busy)return;busy=true;update();notify();
  try{await api('/api/forget',{});hasKey=false;setStatus('missing');}catch(error){handleError(error);}finally{busy=false;update();}
});
$('chatForm').addEventListener('submit',async e=>{
  e.preventDefault();const text=$('prompt').value.trim();if(busy||!hasKey||!text)return;
  const epoch=generation;busy=true;activeId=crypto.randomUUID();controller=new AbortController();update();notify();
  const userRow=appendMessage('user',text), pendingRow=appendMessage('assistant','',true);
  $('prompt').value='';resize();
  try{
    const result=await api('/api/chat',{id:activeId,messages:[...messages,{role:'user',content:text}]},controller.signal);
    if(epoch!==generation)return;
    pendingRow.remove();appendMessage('assistant',result.content);messages.push({role:'user',content:text},{role:'assistant',content:result.content});setStatus(result.connection);
    if(result.truncated)notify('truncated');
  }catch(error){
    if(epoch!==generation)return;
    pendingRow.remove();userRow.remove();$('welcome').hidden=messages.length>0;
    if(!$('prompt').value)$('prompt').value=text;resize();handleError(error);
  }finally{if(epoch===generation){busy=false;activeId=null;controller=null;update();$('prompt').focus();}}
});
async function cancel(clear=false){
  if(busy&&!activeId)return;
  const id=activeId;generation++;controller?.abort();controller=null;activeId=null;busy=true;update();
  const rows=$('messages').querySelectorAll('.message');
  if(clear){messages=[];rows.forEach(r=>r.remove());$('welcome').hidden=false;$('prompt').value='';notify();}
  else { const pending=$('messages').querySelector('.pending');if(pending){const assistant=pending.closest('.message');const user=assistant.previousElementSibling;if(user?.classList.contains('user')){if(!$('prompt').value)$('prompt').value=user.querySelector('.bubble').textContent;user.remove();}assistant.remove();}$('welcome').hidden=messages.length>0;notify('stopped'); }
  try{await api(clear?'/api/new':'/api/cancel',{id});}catch(error){handleError(error);}finally{busy=false;resize();$('prompt').focus();}
}
$('stop').addEventListener('click',()=>cancel());
$('newChat').addEventListener('click',()=>cancel(true));
async function init(){
  try{const response=await fetch('/api/session');const result=await response.json();if(!response.ok)throw new Error();csrf=result.csrf;hasKey=result.hasKey;setStatus(result.connection);}
  catch{notify('initFailed');setStatus('error');}update();
}
$('language').addEventListener('change',()=>applyLanguage($('language').value,true));
applyLanguage(language);
init();
