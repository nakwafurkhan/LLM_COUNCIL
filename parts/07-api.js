<script>
/* ==================== Mesh API layer ==================== */
function authHeaders(){
  if(!cfg.apiKey) throw new Error('No API key set. Open Settings and paste your rsk_ key.');
  return {'Content-Type':'application/json',Authorization:'Bearer '+cfg.apiKey};
}
async function meshError(res){
  let m=`${res.status} ${res.statusText}`;
  try{const j=await res.json(); m=j?.error?.message||m}catch{}
  return new Error(m);
}
/* streaming chat -> calls onDelta(text) */
async function chatStream(model,messages,{signal,onDelta}){
  const res=await fetch(cfg.baseUrl+'/chat/completions',{
    method:'POST',signal,headers:authHeaders(),
    body:JSON.stringify({model,messages,stream:true})
  });
  if(!res.ok) throw await meshError(res);
  const reader=res.body.getReader(),dec=new TextDecoder();
  let buf='',acc='';
  for(;;){
    const {value,done}=await reader.read(); if(done) break;
    buf+=dec.decode(value,{stream:true});
    const lines=buf.split('\n'); buf=lines.pop();
    for(const line of lines){
      const t=line.trim(); if(!t.startsWith('data:')) continue;
      const data=t.slice(5).trim(); if(data==='[DONE]') continue;
      try{
        const d=JSON.parse(data).choices?.[0]?.delta?.content;
        if(d){acc+=d;onDelta(d)}
      }catch{}
    }
  }
  return acc;
}
/* one-shot chat, optional JSON mode with graceful downgrade */
async function chatOnce(model,messages,{signal,json}={}){
  const body={model,messages};
  if(json) body.response_format={type:'json_object'};
  let res=await fetch(cfg.baseUrl+'/chat/completions',{method:'POST',signal,headers:authHeaders(),body:JSON.stringify(body)});
  if(!res.ok&&json&&(res.status===400||res.status===422)){        // model ignores response_format
    delete body.response_format;
    res=await fetch(cfg.baseUrl+'/chat/completions',{method:'POST',signal,headers:authHeaders(),body:JSON.stringify(body)});
  }
  if(!res.ok) throw await meshError(res);
  const j=await res.json();
  return j.choices?.[0]?.message?.content||'';
}
/* pull the first JSON object out of a reply that may be wrapped in prose or fences */
function looseJSON(text){
  if(!text) return null;
  const fence=text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw=fence?fence[1]:text;
  const start=raw.indexOf('{'), end=raw.lastIndexOf('}');
  if(start<0||end<=start) return null;
  try{ return JSON.parse(raw.slice(start,end+1)) }catch{}
  try{ return JSON.parse(raw.slice(start,end+1).replace(/,\s*([}\]])/g,'$1')) }catch{}
  return null;
}

/* ==================== card primitives ==================== */
function stageLabel(parent,n,text,extra){
  const el=document.createElement('div'); el.className='stagelabel';
  el.innerHTML=(n?`<span class="n">${n}</span>`:'')+`<span>${esc(text)}</span>`+
    (extra?`<span class="live" data-live>${esc(extra)}</span>`:'');
  parent.appendChild(el); return el;
}
function makeCard(parent,model,color,kind){
  const el=document.createElement('article');
  el.className = kind==='chair'?'verdict':'card';
  el.style.setProperty('--seatcolor',color);
  el.innerHTML=`<header>
      <div class="avatar">${kind==='chair'?'★':initials(model)}</div>
      <div class="cardname">${esc(kind==='chair'?'Chair':shortName(model))}<span>${esc(model)}</span></div>
      <div class="meta">…</div>
    </header>
    <div class="body">
      <div class="skeleton" style="width:94%"></div>
      <div class="skeleton" style="width:80%"></div>
      <div class="skeleton" style="width:56%"></div>
    </div>`;
  parent.appendChild(el);
  return {el,body:el.querySelector('.body'),meta:el.querySelector('.meta'),head:el.querySelector('header'),model};
}
/* run one model into one card; returns {ok, model, text} */
async function streamInto(card,model,messages,signal,demoKey){
  const t0=performance.now(); let acc='',first=null;
  const paint=()=>{card.body.innerHTML=md(acc)+'<span class="caret"></span> ';stickScroll()};
  const onDelta=d=>{
    if(first===null){first=performance.now()-t0;card.meta.textContent=`${Math.round(first)}ms`}
    acc+=d; paint();
  };
  try{
    if(cfg.conn==='demo'){
      for await(const chunk of demoStream(demoKey||model,messages,signal)) onDelta(chunk);
    }else{
      await chatStream(model,messages,{signal,onDelta});
    }
    const total=Math.round(performance.now()-t0);
    card.body.innerHTML = acc.trim()?md(acc):'<em style="color:var(--ink-3)">Empty response.</em>';
    card.meta.textContent=`${first?Math.round(first)+'ms · ':''}${total}ms · ${acc.split(/\s+/).filter(Boolean).length}w`;
    stickScroll();
    return {ok:true,model,text:acc};
  }catch(err){
    if(err.name==='AbortError'){
      card.body.innerHTML=acc?md(acc)+'<p><em style="color:var(--ink-3)">Stopped.</em></p>':'<em style="color:var(--ink-3)">Stopped.</em>';
      card.meta.textContent='stopped';
      return {ok:false,model,text:acc,stopped:true};
    }
    card.el.classList.add('err');
    const corsy=/Failed to fetch|NetworkError|Load failed/i.test(err.message);
    card.body.innerHTML=`<strong>${esc(err.message)}</strong>`+(corsy
      ? `<p style="margin-top:8px">The browser could not reach <code>${esc(cfg.baseUrl)}</code>. Mesh rejects direct cross-origin calls by design — start the bundled proxy with <code>node server.mjs</code> and switch to <b>Local proxy</b>.</p>`:'');
    card.meta.textContent='failed';
    return {ok:false,model,text:''};
  }
}
function buildMessages(text,img,systemOverride){
  const userContent = img
    ? [{type:'text',text:text||'What do you make of this image?'},{type:'image_url',image_url:{url:img.url,detail:'auto'}}]
    : text;
  const msgs=[];
  const sys=systemOverride!==undefined?systemOverride:cfg.system;
  if(sys) msgs.push({role:'system',content:sys});
  if(cfg.ctxTurns) msgs.push(...convo.slice(-cfg.ctxTurns*2));
  msgs.push({role:'user',content:userContent});
  return {msgs,userContent};
}
function remember(userContent,answer){
  if(!answer) return;
  convo.push({role:'user',content:userContent},{role:'assistant',content:String(answer).slice(0,6000)});
}
</script>
