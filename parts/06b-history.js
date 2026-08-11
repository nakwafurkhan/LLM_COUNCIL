<script>
/* ==================== history / persistence ====================
   Three tiers, decided at boot:
     server  — server.mjs is reachable (Mongo Atlas, or its file fallback)
     local   — no server: keep the last 30 runs in localStorage
   The UI is identical either way; only the badge in the sheet differs.     */
let STORE={tier:'local',driver:'localStorage'};
const LOCAL_RUNS='llm-council-runs';
const apiRoot=()=>cfg.baseUrl.replace(/\/v1\/?$/,'');

async function detectStore(){
  try{
    const r=await fetch(apiRoot()+'/api/health',{signal:AbortSignal.timeout(2500)});
    if(!r.ok) throw 0;
    const j=await r.json();
    STORE={tier:'server',driver:j.driver==='mongo'?'MongoDB':'server file',keyOnServer:!!j.keyOnServer};
  }catch{
    STORE={tier:'local',driver:'this browser'};
  }
  const b=$('#storeBadge'); if(b) b.textContent=STORE.driver;
  return STORE;
}
const localRuns=()=>{try{return JSON.parse(localStorage.getItem(LOCAL_RUNS)||'[]')}catch{return[]}};
const writeLocal=rows=>localStorage.setItem(LOCAL_RUNS,JSON.stringify(rows.slice(0,30)));

async function saveRun(run){
  run.id=run.id||('r'+Date.now().toString(36)+Math.random().toString(36).slice(2,6));
  run.createdAt=run.createdAt||new Date().toISOString();
  run.title=(run.prompt||'').replace(/\s+/g,' ').trim().slice(0,120);
  if(STORE.tier==='server'){
    try{
      await fetch(apiRoot()+'/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(run)});
      return run.id;
    }catch{ /* server went away mid-session — fall through to local */ }
  }
  const rows=localRuns().filter(r=>r.id!==run.id);
  rows.unshift(run); writeLocal(rows);
  return run.id;
}
async function listRuns(q){
  if(STORE.tier==='server'){
    try{
      const r=await fetch(apiRoot()+'/api/runs?limit=60'+(q?'&q='+encodeURIComponent(q):''));
      return (await r.json()).runs||[];
    }catch{}
  }
  const rows=localRuns();
  if(!q) return rows;
  const n=q.toLowerCase();
  return rows.filter(r=>(r.title||'').toLowerCase().includes(n)||(r.prompt||'').toLowerCase().includes(n));
}
async function getRun(id){
  if(STORE.tier==='server'){
    try{ const r=await fetch(apiRoot()+'/api/runs/'+id); if(r.ok) return await r.json() }catch{}
  }
  return localRuns().find(r=>r.id===id)||null;
}
async function deleteRun(id){
  if(STORE.tier==='server'){
    try{ await fetch(apiRoot()+'/api/runs/'+id,{method:'DELETE'}) }catch{}
  }
  writeLocal(localRuns().filter(r=>r.id!==id));
}

/* ---- settings sync. The Mesh key is never sent. ---- */
function syncableSettings(){
  const {apiKey,...rest}=cfg;
  return rest;
}
let syncTimer=null;
function pushSettings(){
  if(STORE.tier!=='server') return;
  clearTimeout(syncTimer);
  syncTimer=setTimeout(()=>{
    fetch(apiRoot()+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(syncableSettings())}).catch(()=>{});
  },900);
}
async function pullSettingsIfFresh(){
  /* Only adopt server settings on a browser that has none of its own, so a
     second device inherits your setup without clobbering a configured one. */
  if(STORE.tier!=='server') return;
  if(localStorage.getItem('llm-council-v2')) return;
  try{
    const r=await fetch(apiRoot()+'/api/settings');
    const s=await r.json();
    if(s&&Object.keys(s).length>1){
      cfg={...cfg,...s,apiKey:cfg.apiKey};
      saveCfg(); paintSettings(); setRunMode(cfg.runMode,{silent:true}); applyTheme();
      toast('Settings restored from '+STORE.driver);
    }
  }catch{}
}

/* ==================== history UI ==================== */
const MODE_META={
  quick:{t:'Quick',c:'var(--accent)'},council:{t:'Council',c:'var(--chair)'},
  study:{t:'Study',c:'var(--sys-teal)'},humanize:{t:'Humanize',c:'var(--sys-green)'}
};
function ago(iso){
  const s=(Date.now()-new Date(iso).getTime())/1000;
  if(s<60) return 'just now';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  if(s<604800) return Math.floor(s/86400)+'d ago';
  return new Date(iso).toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
async function paintHistory(q){
  const box=$('#historyList'), empty=$('#historyEmpty');
  box.innerHTML=''; empty.hidden=true;
  const rows=await listRuns(q);
  if(!rows.length){
    empty.hidden=false;
    empty.textContent=q?'Nothing matches that.':'No saved runs yet. Ask something and it lands here.';
    return;
  }
  rows.forEach((r,i)=>{
    const m=MODE_META[r.mode]||MODE_META.quick;
    const el=document.createElement('div');
    el.className='hrow'; el.style.animationDelay=(i*26)+'ms';
    el.innerHTML=`<span class="hdot" style="background:${m.c}"></span>
      <button class="hopen">
        <span class="htitle">${esc(r.title||r.prompt||'(untitled)')}</span>
        <span class="hmeta">${m.t} · ${ago(r.createdAt)}${r.models&&r.models.length>1?' · '+r.models.length+' models':''}</span>
      </button>
      <button class="hdel" aria-label="Delete">✕</button>`;
    el.querySelector('.hopen').onclick=()=>openRun(r.id);
    el.querySelector('.hdel').onclick=async()=>{
      await deleteRun(r.id);
      el.style.opacity='0'; el.style.transform='translateX(12px)';
      setTimeout(()=>paintHistory($('#historyQuery').value.trim()),200);
    };
    box.appendChild(el);
  });
}
async function openRun(id){
  const run=await getRun(id);
  if(!run){toast('That run could not be loaded');return}
  closePanels();
  if(heroNode.parentNode) heroNode.remove();
  replayRun(run);
  toast('Restored from '+STORE.driver);
}

/* rebuild a saved run with the same renderers the live path uses,
   so flashcards still flip and the copy button still copies */
function replayRun(run){
  const p=run.payload||{};
  const turn=document.createElement('section'); turn.className='turn';
  const tag={quick:'⚡ Quick',council:'⚖︎ Council',study:'✦ Deep study',humanize:'✎ Humanize'}[run.mode]||'⚡ Quick';
  turn.innerHTML=`<div class="usermsg"><div class="bubble">
      <div class="modetag">${tag} · saved ${esc(ago(run.createdAt))}</div>
      ${p.image?`<img src="${esc(p.image)}" alt="">`:''}${esc(run.prompt)||'<em>(image only)</em>'}
    </div></div>`;
  $('#wrap').appendChild(turn);

  if(run.mode==='quick'){
    const c=makeCard(turn,p.model||'',  'var(--accent)');
    c.body.innerHTML=md(p.text||''); c.meta.textContent='saved';
  }
  else if(run.mode==='council'){
    stageLabel(turn,'1','Deliberation');
    const grid=document.createElement('div'); grid.className='grid'; turn.appendChild(grid);
    const cards=(p.seats||[]).map((s,i)=>{
      const c=makeCard(grid,s.model,seatColor(i));
      c.body.innerHTML=s.text?md(s.text):'<em style="color:var(--ink-3)">No answer saved.</em>';
      c.meta.textContent='saved';
      return c;
    });
    if(p.ranking&&p.ranking.length){
      stageLabel(turn,'2','Anonymous peer review');
      const board=document.createElement('div'); board.className='board'; turn.appendChild(board);
      const ranking=p.ranking.map(r=>({...r,color:seatColor(r.idx)}));
      renderBoard(board,ranking,p.seats||[]);
      ranking.forEach(r=>{
        const card=cards[r.idx]; if(!card||!r.count) return;
        const chip=document.createElement('span');
        chip.className='scorechip'+(r.rank===1?' top':'');
        chip.textContent=(r.rank===1?'★ ':'#'+r.rank+' ')+Number(r.mean).toFixed(1);
        card.meta.parentNode.insertBefore(chip,card.meta);
      });
    }
    if(p.chair&&p.chair.text){
      stageLabel(turn,'3','Chairman synthesis');
      const v=makeCard(turn,p.chair.model,'var(--chair)','chair');
      v.body.innerHTML=md(p.chair.text); v.meta.textContent='saved';
    }
  }
  else if(run.mode==='study'){
    stageLabel(turn,null,'Study pack');
    const pack=document.createElement('article');
    pack.className='pack';
    pack.innerHTML=`<header><div class="avatar">✦</div>
      <div class="cardname">Study pack<span>${esc(p.model||'')}</span></div>
      <div class="meta">saved</div></header><div class="body" data-live></div>`;
    turn.appendChild(pack);
    renderPack(pack,pack.querySelector('[data-live]'),p.raw||'',run.prompt);
  }
  else if(run.mode==='humanize'){
    stageLabel(turn,null,'Humanized');
    const card=document.createElement('article');
    card.className='human';
    card.innerHTML=`<header><div class="avatar">H</div>
      <div class="cardname">Humanized<span>${esc(p.model||'')}</span></div>
      <div class="meta">saved</div></header><div class="finalwrap" data-live></div>`;
    turn.appendChild(card);
    renderHumanized(card,card.querySelector('[data-live]'),p.raw||'',run.prompt);
  }
  stick=true; stickScroll();
}

$('#btnHistory').onclick=async()=>{
  openPanel('#historyPanel');
  $('#historyQuery').value='';
  await detectStore();
  paintHistory();
};
$('#historyQuery').addEventListener('input',e=>{
  clearTimeout(e.target._t);
  e.target._t=setTimeout(()=>paintHistory(e.target.value.trim()),220);
});
$('#btnWipeHistory').onclick=async()=>{
  if(!confirm('Delete every saved run? This cannot be undone.')) return;
  if(STORE.tier==='server'){ try{ await fetch(apiRoot()+'/api/runs',{method:'DELETE'}) }catch{} }
  writeLocal([]);
  paintHistory(); toast('History cleared');
};
</script>
