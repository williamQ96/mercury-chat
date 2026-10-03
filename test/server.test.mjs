import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { translations } from '../public/i18n.mjs';

const fixtureKey = 'TEST_ONLY_NOT_A_REAL_CREDENTIAL';
const reply = content => new Response(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}), {status:200});
const waiting = (_url, {signal}) => new Promise((resolve,reject) => {
  signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
});
async function setup(t, transport, timeoutMs=500) {
  const server=createApp({transport,timeoutMs});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  const response=await fetch(base+'/api/session'), state=await response.json();
  const headers={'Content-Type':'application/json','Origin':base,'X-CSRF-Token':state.csrf,'Cookie':response.headers.get('set-cookie').split(';')[0]};
  const post=async(path,data={},overrides={})=>{
    const res=await fetch(base+path,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(data)});
    return {status:res.status,data:await res.json(),headers:res.headers};
  };
  return {base,post,state,headers};
}
test('private session, no false connected status, missing key, same origin protection',async t=>{
  const app=await setup(t,()=>assert.fail('upstream must not be called'));
  assert.equal(app.state.hasKey,false);assert.equal(app.state.connection,'missing');
  assert.equal((await app.post('/api/chat',{id:'a',messages:[{role:'user',content:'hello'}]})).status,401);
  assert.equal((await app.post('/api/key',{key:fixtureKey},{Origin:'https://evil.example'})).status,403);
  assert.equal((await app.post('/api/key',{key:fixtureKey},{'X-CSRF-Token':'bad'})).status,403);
  const wrongHost=await new Promise((resolve,reject)=>{const req=http.get(app.base+'/api/session',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(wrongHost,403);
  const page=await fetch(app.base+'/');assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(page.headers.get('access-control-allow-origin'),null);
});
test('multi-turn, fixed destination, redirect protection, key masking, forget',async t=>{
  let calls=[];
  const app=await setup(t,async(url,options)=>{calls.push({url,options});return reply(`**回复** ${fixtureKey}`);});
  const saved=await app.post('/api/key',{key:fixtureKey});assert.equal(saved.data.connection,'unverified');assert.ok(!JSON.stringify(saved.data).includes(fixtureKey));
  const messages=[{role:'user',content:'first'},{role:'assistant',content:'answer'},{role:'user',content:'second'}];
  const result=await app.post('/api/chat',{id:'first',messages});assert.equal(result.status,200);assert.equal(result.data.content,'**回复** [API key hidden]');
  assert.equal(calls[0].url,'http://127.0.0.1:18000/v1/chat/completions');assert.equal(calls[0].options.redirect,'error');
  const sent=JSON.parse(calls[0].options.body);assert.deepEqual(sent.messages,messages);assert.equal(sent.model,'qwen3-235b');assert.equal(sent.stream,false);
  assert.equal((await app.post('/api/forget')).data.hasKey,false);
  assert.equal((await app.post('/api/chat',{id:'next',messages})).status,401);
});
test('401 never forwards upstream body or echoes key',async t=>{
  const app=await setup(t,async()=>new Response(fixtureKey,{status:401}));await app.post('/api/key',{key:fixtureKey});
  const result=await app.post('/api/chat',{id:'a',messages:[{role:'user',content:'hello'}]});assert.equal(result.status,401);assert.equal(result.data.error.code,'unauthorized');assert.ok(!JSON.stringify(result).includes(fixtureKey));
});
test('tunnel down and timeout have helpful errors',async t=>{
  const app=await setup(t,async()=>{throw new TypeError('fetch failed');});await app.post('/api/key',{key:fixtureKey});
  const result=await app.post('/api/check',{id:'a'});assert.equal(result.status,502);assert.equal(result.data.error.code,'unreachable');assert.match(result.data.error.message,/SSH/);
  const timed=await setup(t,waiting,30);await timed.post('/api/key',{key:fixtureKey});
  const timeout=await timed.post('/api/chat',{id:'a',messages:[{role:'user',content:'hi'}]});assert.equal(timeout.status,504);assert.equal(timeout.data.error.code,'timeout');
});
test('duplicate send rejected; cancel, immediate resubmit, and new conversation',async t=>{
  let started;const startedPromise=new Promise(r=>started=r);let count=0;
  const app=await setup(t,(url,opts)=>{if(++count===1){started();return waiting(url,opts);}return Promise.resolve(reply('ok'));});await app.post('/api/key',{key:fixtureKey});
  const payload={id:'slow',messages:[{role:'user',content:'slow'}]};const first=app.post('/api/chat',payload);await startedPromise;
  assert.equal((await app.post('/api/chat',{...payload,id:'duplicate'})).status,409);
  assert.equal((await app.post('/api/cancel',{id:'slow'})).status,200);
  const next=await app.post('/api/chat',{...payload,id:'next'});assert.equal(next.status,200);
  assert.equal((await first).data.error.code,'cancelled');assert.equal((await app.post('/api/new')).status,200);
});
test('new aborts active request and check validates model',async t=>{
  let started;const signal=new Promise(r=>started=r);
  const app=await setup(t,(url,opts)=>{started();return waiting(url,opts);});await app.post('/api/key',{key:fixtureKey});
  const pending=app.post('/api/chat',{id:'slow',messages:[{role:'user',content:'hi'}]});await signal;
  await app.post('/api/new');assert.equal((await pending).data.error.code,'cancelled');
  const model=await setup(t,async()=>new Response(JSON.stringify({data:[{id:'qwen3-235b'}]})));await model.post('/api/key',{key:fixtureKey});
  assert.equal((await model.post('/api/check',{id:'check'})).data.connection,'available');
});
test('invalid messages, empty replies, missing model, and upstream errors are bounded',async t=>{
  const app=await setup(t,async()=>reply(''));await app.post('/api/key',{key:fixtureKey});
  assert.equal((await app.post('/api/chat',{id:'x',messages:[{role:'system',content:'bad'}]})).status,400);
  assert.equal((await app.post('/api/chat',{id:'x',messages:[{role:'user',content:'hi'}]})).data.error.code,'empty');
  const missing=await setup(t,async()=>new Response(JSON.stringify({data:[{id:'other'}]})));await missing.post('/api/key',{key:fixtureKey});
  assert.equal((await missing.post('/api/check',{id:'check'})).data.error.code,'model');
  const failed=await setup(t,async()=>new Response(fixtureKey,{status:503}));await failed.post('/api/key',{key:fixtureKey});
  const result=await failed.post('/api/chat',{id:'x',messages:[{role:'user',content:'hi'}]});assert.equal(result.status,502);assert.ok(!JSON.stringify(result).includes(fixtureKey));
});
test('English is default; Chinese API errors are opt-in; dictionaries are complete',async t=>{
  const app=await setup(t,()=>assert.fail('no upstream call needed'));
  const english=await app.post('/api/chat',{id:'x',messages:[{role:'user',content:'hi'}]});
  assert.equal(english.data.error.message,'Enter your API key first.');
  const chinese=await app.post('/api/chat',{id:'x',messages:[{role:'user',content:'hi'}]},{'X-Language':'zh'});
  assert.equal(chinese.data.error.message,'请先输入 API 密钥。');
  const keys=value=>Object.entries(value).flatMap(([k,v])=>typeof v==='object'?keys(v).map(child=>k+'.'+child):[k]).sort();
  assert.deepEqual(keys(translations.en),keys(translations.zh));
  for(const key of keys(translations.en))for(const lang of ['en','zh'])assert.ok(key.split('.').reduce((v,k)=>v[k],translations[lang]).trim());
  const page=await(await fetch(app.base+'/')).text();assert.match(page,/<html lang="en">/);assert.match(page,/<title>mercury chat<\/title>/);
});
