// Dependency-free Chromium DevTools smoke tests. Mock keys only; no user profile.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { translations } from '../public/i18n.mjs';

const language=process.env.CHAT_TEST_LANGUAGE==='zh'?'zh':'en';
const words=translations[language];

const chrome = process.env.CHAT_TEST_CHROME || path.join(process.env.LOCALAPPDATA || path.dirname(tmpdir()),'ms-playwright','chromium-1223','chrome-win64','chrome.exe');
const profile=await mkdtemp(path.join(tmpdir(),'mercury-chat-ui-'));
const artifacts=new URL('../test-artifacts/',import.meta.url);await mkdir(artifacts,{recursive:true});
let mode='normal', calls=[];
const mock=createApp({timeoutMs:1000,transport:async(url,opts)=>{
  if(url.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'qwen3-235b'}]}));
  calls.push(JSON.parse(opts.body));
  if(mode==='401')return new Response('private upstream error',{status:401});
  if(mode==='down')throw new TypeError('fetch failed');
  if(mode==='slow')return new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}));
  await new Promise(r=>setTimeout(r,100));
  return new Response(JSON.stringify({choices:[{message:{content:'# 模拟回复\n**安全 Markdown**\n```js\nconst n = 1;\n```\n<img src=x onerror="window.pwned=1">'},finish_reason:'stop'}]}));
}});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${mock.address().port}`;
const child=spawn(chrome,['--headless=new','--no-first-run','--no-default-browser-check','--disable-gpu','--disable-extensions','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let ws, browserDiagnostic='';
child.stderr.on('data',data=>{browserDiagnostic+=data.toString();});
try {
  const debug=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('Chromium debug startup timed out')),10000);child.on('error',reject);child.stderr.on('data',data=>{text+=data;const m=text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/);if(m){clearTimeout(timer);resolve(`http://127.0.0.1:${m[1]}`);}});});
  let target;
  for(let i=0;i<60&&!target;i++){try{const pages=await(await fetch(debug+'/json/list')).json();target=pages.find(p=>p.type==='page');}catch{}if(!target)await new Promise(r=>setTimeout(r,50));}
  if(!target)throw new Error('Chromium did not create a page target');
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let counter=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}});
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++counter;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.text+': '+r.exceptionDetails.exception?.description);return r.result.value;};
  const wait=async expression=>{for(let i=0;i<80;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error('Wait failed: '+expression);};
  await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1280,height:850,deviceScaleFactor:1,mobile:false});
  const status=state=>`document.getElementById('status')?.textContent===${JSON.stringify(words.status[state])}`;
  const switchLanguage=async lang=>{await evaluate(`document.getElementById('language').value=${JSON.stringify(lang)};document.getElementById('language').dispatchEvent(new Event('change'))`);};
  const verifyTranslations=async lang=>{
    const result=await evaluate(`(async()=>{const {translations}=await import('/i18n.mjs');const t=k=>k.split('.').reduce((v,p)=>v[p],translations[${JSON.stringify(lang)}]);return {text:[...document.querySelectorAll('[data-i18n]')].filter(e=>!['status','hint'].includes(e.id)).every(e=>e.textContent===t(e.dataset.i18n)),placeholder:[...document.querySelectorAll('[data-i18n-placeholder]')].every(e=>e.placeholder===t(e.dataset.i18nPlaceholder)),aria:[...document.querySelectorAll('[data-i18n-aria]')].every(e=>e.getAttribute('aria-label')===t(e.dataset.i18nAria)),lang:document.documentElement.lang,title:document.title}})()`);
    assert.deepEqual(result,{text:true,placeholder:true,aria:true,lang:lang==='zh'?'zh-CN':'en',title:'mercury chat'});
  };
  await send('Page.navigate',{url:base});await wait("document.getElementById('status')?.textContent==='Waiting for an API key'");
  await verifyTranslations('en');
  assert.equal(await evaluate("document.getElementById('apiKey').type"),'password');
  assert.equal(await evaluate('localStorage.length + sessionStorage.length'),0);
  if(language==='zh')await switchLanguage('zh');
  await verifyTranslations(language);
  await evaluate("document.getElementById('prompt').focus()");
  await send('Input.insertText',{text:'line one'});
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:8,text:'\r',unmodifiedText:'\r'});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:8});
  await send('Input.insertText',{text:'line two'});
  assert.equal(await evaluate("document.getElementById('prompt').value"),'line one\nline two');
  await evaluate("document.getElementById('prompt').value=''");
  await evaluate("document.getElementById('apiKey').value='UI_TEST_ONLY_NOT_REAL';document.getElementById('keyForm').requestSubmit()");
  await wait(status('unverified'));
  assert.equal(await evaluate("document.getElementById('apiKey').value"),'');
  assert.equal(await evaluate("document.getElementById('prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))"),true);
  await evaluate("document.getElementById('check').click()");await wait(status('available'));
  await evaluate("document.getElementById('prompt').value='第一轮';document.getElementById('prompt').dispatchEvent(new Event('input'));document.getElementById('chatForm').requestSubmit();document.getElementById('chatForm').requestSubmit()");
  await wait("document.querySelectorAll('.message').length===2&&!document.getElementById('send').hidden");assert.equal(calls.length,1);
  assert.equal(await evaluate("document.querySelectorAll('.bubble img').length"),0);assert.equal(await evaluate("window.pwned===1"),false);
  assert.equal(await evaluate("document.querySelector('.bubble strong').textContent"),'安全 Markdown');
  await evaluate("document.getElementById('prompt').value='第二轮';document.getElementById('prompt').dispatchEvent(new Event('input'));document.getElementById('prompt').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
  await wait("document.querySelectorAll('.message').length===4&&!document.getElementById('send').hidden");assert.equal(calls.at(-1).messages.length,3);
  const oldCallCount=calls.length;
  await switchLanguage(language==='en'?'zh':'en');await verifyTranslations(language==='en'?'zh':'en');
  assert.equal(await evaluate("document.querySelectorAll('.message').length"),4);assert.equal(calls.length,oldCallCount);
  await switchLanguage(language);await verifyTranslations(language);
  mode='slow';await evaluate("document.getElementById('prompt').value='停止后重发';document.getElementById('chatForm').requestSubmit()");
  await wait("document.querySelector('.pending')!==null");await evaluate("document.getElementById('stop').click()");await wait("document.querySelector('.pending')===null&&!document.getElementById('send').hidden");
  assert.equal(await evaluate("document.getElementById('prompt').value"),'停止后重发');assert.equal(await evaluate("document.querySelectorAll('.message').length"),4);
  mode='normal';await evaluate("document.getElementById('chatForm').requestSubmit()");await wait("document.querySelectorAll('.message').length===6&&!document.getElementById('send').hidden");assert.equal(calls.at(-1).messages.length,5);
  mode='slow';await evaluate("document.getElementById('prompt').value='新对话取消';document.getElementById('chatForm').requestSubmit()");await wait("document.querySelector('.pending')!==null");await evaluate("document.getElementById('newChat').click()");await wait("document.querySelectorAll('.message').length===0&&!document.getElementById('send').hidden");
  mode='401';await evaluate("document.getElementById('prompt').value='401';document.getElementById('chatForm').requestSubmit()");await wait(status('unauthorized'));assert.equal(await evaluate("document.getElementById('notice').textContent"),words.errors.unauthorized);
  await switchLanguage(language==='en'?'zh':'en');assert.equal(await evaluate("document.getElementById('notice').textContent"),translations[language==='en'?'zh':'en'].errors.unauthorized);await switchLanguage(language);
  mode='down';await evaluate("document.getElementById('prompt').value='隧道断开';document.getElementById('chatForm').requestSubmit()");await wait(status('unreachable'));assert.match(await evaluate("document.getElementById('notice').textContent"),/SSH/);
  await evaluate("document.getElementById('newChat').click()");await wait("!document.getElementById('send').hidden");
  mode='normal';await evaluate("document.getElementById('prompt').value='截图示例';document.getElementById('chatForm').requestSubmit()");await wait("document.querySelectorAll('.message').length===2&&!document.getElementById('send').hidden");
  let shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(new URL(`chat-mock-desktop-${language}.png`,artifacts),Buffer.from(shot.data,'base64'));
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.equal(await evaluate('document.documentElement.scrollWidth<=390'),true);shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(new URL(`chat-mock-mobile-${language}.png`,artifacts),Buffer.from(shot.data,'base64'));
  assert.deepEqual(await evaluate('Object.keys(localStorage)'),['mercury-chat-language']);
  assert.equal(await evaluate("localStorage.getItem('mercury-chat-language')"),language);
  await send('Page.reload');await wait(status('verified'));await verifyTranslations(language);
  assert.equal(await evaluate("document.querySelectorAll('.message').length"),0);
  // Screenshot of the real local app without any key or authenticated call.
  await send('Emulation.setDeviceMetricsOverride',{width:1280,height:850,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:'http://127.0.0.1:7860/'});
  await wait("document.getElementById('status')?.textContent==='Waiting for an API key'");await verifyTranslations('en');shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(new URL('chat-local-ready.png',artifacts),Buffer.from(shot.data,'base64'));
  const checks=['Password field and cleared key input','No key or chat browser storage','Honest connection states','Double submit sends once','Safe Markdown / XSS literal','Multi-turn context','Enter submits','Shift+Enter inserts newline','IME composition Enter ignored','Stop removes pending and restores prompt','Immediate resubmit has correct history','New chat aborts and clears','401 readable error','Tunnel down readable error','390px mobile has no horizontal overflow','Real app unauthed ready screenshot','Fresh English default and exact lowercase title','Complete translated labels, placeholders, and ARIA','Switch language preserves conversation without sending','Displayed error switches language','Only language preference persists after reload'];
  await writeFile(new URL(`ui-results-${language}.json`,artifacts),JSON.stringify({passed:true,language,checks,liveAuthenticatedChat:false},null,2));console.log(JSON.stringify({passed:true,language,checks},null,2));
} catch(error) {
  console.error(browserDiagnostic.slice(-3500));throw error;
} finally {
  ws?.close();child.kill();mock.closeAllConnections();await new Promise(r=>mock.close(r));
  await new Promise(r=>setTimeout(r,500));try{await rm(profile,{recursive:true,force:true});}catch{}
}
