<script>
/* ==================== settings ==================== */
function paintSettings(){
  $$('#connSeg button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===cfg.conn)));
  $('#baseUrl').value=cfg.baseUrl; $('#apiKey').value=cfg.apiKey;
  $('#quickModel').value=cfg.quickModel; $('#studyModel').value=cfg.studyModel;
  $('#humanizeModel').value=cfg.humanizeModel; $('#voiceSample').value=cfg.voiceSample;
  $('#chairModel').value=cfg.chair; $('#sysPrompt').value=cfg.system;
  $('#ctxTurns').value=String(cfg.ctxTurns); $('#imgSource').value=cfg.imgSource;
  $('#peerSwitch').setAttribute('aria-checked',String(!!cfg.peer));
  const list=$('#seatList'); list.innerHTML='';
  cfg.seats.forEach((seat,i)=>{
    const el=document.createElement('div'); el.className='seat'; el.style.animationDelay=(i*40)+'ms';
    el.innerHTML=`<input type="checkbox" ${seat.on?'checked':''} aria-label="Seat active">
      <span class="sw" style="background:${seatColor(i)}"></span>
      <input type="text" value="${esc(seat.model)}" spellcheck="false" style="flex:1">
      <button class="del" aria-label="Remove seat">✕</button>`;
    el.querySelector('[type=checkbox]').onchange=e=>{seat.on=e.target.checked;saveCfg();refreshStatus()};
    el.querySelector('[type=text]').onchange=e=>{seat.model=e.target.value.trim();saveCfg();refreshStatus()};
    el.querySelector('.del').onclick=()=>{cfg.seats=cfg.seats.filter(x=>x!==seat);saveCfg();paintSettings();refreshStatus()};
    list.appendChild(el);
  });
}
$$('#connSeg button').forEach(b=>b.onclick=()=>{
  cfg.conn=b.dataset.mode;
  if(cfg.conn==='proxy'&&!/localhost|127\.0\.0\.1/.test(cfg.baseUrl)) cfg.baseUrl='http://localhost:8787/v1';
  if(cfg.conn==='direct') cfg.baseUrl='https://api.meshapi.ai/v1';
  saveCfg(); paintSettings(); refreshStatus();
});
$('#baseUrl').onchange=e=>{cfg.baseUrl=e.target.value.trim().replace(/\/$/,'');saveCfg()};
$('#apiKey').onchange=e=>{                       // Postel: tolerate quotes / Bearer / whitespace
  cfg.apiKey=e.target.value.trim().replace(/^["']|["']$/g,'').replace(/^Bearer\s+/i,'');
  e.target.value=cfg.apiKey;
  if(cfg.apiKey&&cfg.conn==='demo'){cfg.conn='proxy';paintSettings()}
  saveCfg(); refreshStatus();
};
$('#btnReveal').onclick=()=>{const f=$('#apiKey'),p=f.type==='password';f.type=p?'text':'password';$('#btnReveal').textContent=p?'Hide':'Show'};
$('#btnForget').onclick=()=>{cfg.apiKey='';cfg.conn='demo';saveCfg();paintSettings();refreshStatus();toast('Key removed from this browser')};
$('#quickModel').onchange=e=>{cfg.quickModel=e.target.value.trim();saveCfg()};
$('#studyModel').onchange=e=>{cfg.studyModel=e.target.value.trim();saveCfg()};
$('#humanizeModel').onchange=e=>{cfg.humanizeModel=e.target.value.trim();saveCfg()};
$('#voiceSample').onchange=e=>{cfg.voiceSample=e.target.value.trim();saveCfg();refreshStatus()};
$('#chairModel').onchange=e=>{cfg.chair=e.target.value.trim();saveCfg()};
$('#sysPrompt').onchange=e=>{cfg.system=e.target.value;saveCfg()};
$('#ctxTurns').onchange=e=>{cfg.ctxTurns=+e.target.value;saveCfg()};
$('#imgSource').onchange=e=>{cfg.imgSource=e.target.value;saveCfg()};
$('#peerSwitch').onclick=e=>{cfg.peer=!cfg.peer;e.currentTarget.setAttribute('aria-checked',String(cfg.peer));saveCfg();refreshStatus()};
$('#btnAddSeat').onclick=()=>{
  const v=$('#newSeat').value.trim(); if(!v) return;
  cfg.seats.push({id:uid(),model:v,on:true}); $('#newSeat').value=''; saveCfg(); paintSettings(); refreshStatus();
};
$('#newSeat').addEventListener('keydown',e=>{if(e.key==='Enter')$('#btnAddSeat').click()});
$('#btnTest').onclick=async()=>{
  const out=$('#testResult');
  if(cfg.conn==='demo'){out.innerHTML='<span style="color:var(--warn)">Demo mode — nothing to test.</span>';return}
  if(!cfg.apiKey){out.innerHTML='<span style="color:var(--err)">Add your rsk_ key first.</span>';return}
  out.textContent='Testing…';
  try{
    const r=await fetch(cfg.baseUrl+'/models',{headers:{Authorization:'Bearer '+cfg.apiKey}});
    const j=await r.json().catch(()=>({}));
    out.innerHTML = r.ok
      ? `<span style="color:var(--ok)">Connected — ${(j.data||[]).length||'?'} models visible.</span>`
      : `<span style="color:var(--err)">${r.status}: ${esc(j?.error?.message||'rejected')}</span>`;
  }catch{
    out.innerHTML='<span style="color:var(--err)">Network/CORS failure. Mesh refuses direct browser origins — run <code>node server.mjs</code> and pick Local proxy.</span>';
  }
  refreshStatus();
};

/* ==================== image search ==================== */
async function searchImages(q){
  const grid=$('#imgResults'),empty=$('#imgEmpty');
  grid.innerHTML=''; empty.hidden=false; empty.textContent='Searching…';
  try{
    let items=[];
    if(cfg.imgSource==='mesh'&&cfg.conn!=='demo'&&cfg.apiKey){
      const r=await fetch(cfg.baseUrl+'/web/search',{
        method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+cfg.apiKey},
        body:JSON.stringify({query:q+' image',max_results:12})
      });
      const j=await r.json();
      items=(j.results||[]).filter(x=>x.image||x.thumbnail)
        .map(x=>({url:x.image||x.thumbnail,thumb:x.thumbnail||x.image,title:x.title||q,by:''}));
      if(!items.length) throw new Error('no image results from Mesh');
    }else{
      const r=await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=18&mature=false`);
      const j=await r.json();
      items=(j.results||[]).map(x=>({url:x.url,thumb:x.thumbnail||x.url,title:x.title||q,by:x.creator||''}));
    }
    if(!items.length){empty.textContent='Nothing found. Try different words.';return}
    empty.hidden=true;
    items.forEach((it,i)=>{
      const fig=document.createElement('figure');
      fig.className='imgcell'; fig.style.animationDelay=(i*28)+'ms';
      fig.innerHTML=`<img src="${esc(it.thumb)}" alt="${esc(it.title)}" loading="lazy">
                     <figcaption>${esc(it.title)}${it.by?' · '+esc(it.by):''}</figcaption>`;
      fig.tabIndex=0; fig.setAttribute('role','button');
      const pick=()=>{setAttachment({url:it.url,name:it.title});closePanels();toast('Image attached')};
      fig.onclick=pick; fig.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();pick()}};
      grid.appendChild(fig);
    });
  }catch(err){ empty.textContent='Search failed: '+err.message }
}
$('#btnImgSearch').onclick=()=>{const q=$('#imgQuery').value.trim();if(q)searchImages(q)};
$('#imgQuery').addEventListener('keydown',e=>{if(e.key==='Enter')$('#btnImgSearch').click()});
$('#btnUpload').onclick=()=>$('#fileInput').click();
$('#fileInput').onchange=e=>{
  const f=e.target.files[0]; if(!f) return;
  const rd=new FileReader();
  rd.onload=()=>{setAttachment({url:rd.result,name:f.name});closePanels();toast('Image attached')};
  rd.readAsDataURL(f);
};
function setAttachment(a){
  attachment=a; const row=$('#attachRow');
  if(!a){row.hidden=true;row.innerHTML='';syncSend();return}
  row.hidden=false;
  row.innerHTML=`<div class="attach"><img src="${esc(a.url)}" alt=""><span class="t">${esc(a.name||'image')}</span>
    <button class="x" aria-label="Remove">✕</button></div>`;
  row.querySelector('.x').onclick=()=>setAttachment(null);
  syncSend();
}

/* ==================== composer ==================== */
const input=$('#input');
function autoGrow(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight,190)+'px'}
function syncSend(){$('#send').disabled = running?false:!(input.value.trim()||attachment)}
input.addEventListener('input',()=>{autoGrow();syncSend()});
input.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!$('#send').disabled)submit()}
});
$('#send').onclick=()=>{running?stopRun():submit()};
const heroNode=$('#hero');
$('#btnClear').onclick=()=>{
  stopRun(); convo=[]; $('#wrap').innerHTML=''; $('#wrap').appendChild(heroNode);
  heroNode.style.animation='none'; void heroNode.offsetWidth; heroNode.style.animation='';
  setAttachment(null); paintSuggests(); toast('Cleared');
};
function stopRun(){
  if(running){running.abort();running=null}
  $('#send').classList.remove('stop');
  $('#sendIcon').innerHTML='<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>';
  syncSend();
}
function startRun(){
  running=new AbortController();
  $('#send').classList.add('stop'); $('#send').disabled=false;
  $('#sendIcon').innerHTML='<rect x="7.5" y="7.5" width="9" height="9" rx="1.8" fill="currentColor" stroke="none"/>';
  return running.signal;
}

/* sticky scroll */
const scroller=$('#stream');
let stick=true, rafPending=false;
scroller.addEventListener('scroll',()=>{
  stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 110;
});
function stickScroll(){
  if(!stick||rafPending) return;
  rafPending=true;
  requestAnimationFrame(()=>{rafPending=false;scroller.scrollTop=scroller.scrollHeight});
}
</script>
