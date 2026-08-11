<script>
/* ==================== DEEP STUDY ==================== */
const STUDY_SYS=`You build rigorous study packs. Given a topic, produce ONE markdown document using EXACTLY these section headers, in this order, and nothing outside them:

## ORIENT
Two or three sentences: what this is, and why it is worth knowing. No throat-clearing.

## MAP
5-8 bullets. Each is "**Term** — one-line definition". These are the concepts everything else hangs on.

## CORE
Three labelled passes over the same idea, each a short paragraph:
**Plainly:** the intuition, no jargon.
**Properly:** the real mechanism, with the correct terminology.
**Deeper:** the subtlety an expert cares about — an edge case, a limitation, a common formal statement.

## MISCONCEPTIONS
3-5 bullets, each formatted "Wrong: … → Right: …".

## EXAMPLE
One concrete worked example or scenario, stepped through. Use a numbered list.

## FLASHCARDS
8-12 lines, each formatted exactly "question :: answer". No bullets, no numbering. Keep answers under 20 words.

## QUIZ
5 questions. Format each as a numbered question line followed by a line starting "Answer:".

## GO DEEPER
3-4 bullets naming specific books, papers, or courses, each with a clause on why.

Write for an intelligent adult who is new to this topic. Be concrete. Prefer real numbers and named examples over vague description.`;

async function runStudy(turn,topic,signal){
  stageLabel(turn,null,'Building your study pack');
  const pack=document.createElement('article');
  pack.className='pack';
  pack.innerHTML=`<header>
      <div class="avatar">✦</div>
      <div class="cardname">Study pack<span>${esc(cfg.studyModel)}</span></div>
      <div class="meta">…</div>
    </header>
    <div class="body" data-live></div>`;
  turn.appendChild(pack); stickScroll();

  const body=pack.querySelector('[data-live]');
  const meta=pack.querySelector('.meta');
  body.innerHTML='<div class="progressline"><i></i></div><div style="margin-top:12px"><div class="skeleton" style="width:92%"></div><div class="skeleton" style="width:76%"></div><div class="skeleton" style="width:58%"></div></div>';

  const t0=performance.now(); let acc='',first=null;
  const onDelta=d=>{
    if(first===null){first=performance.now()-t0}
    acc+=d;
    body.innerHTML=md(acc)+'<span class="caret" style="--seatcolor:var(--sys-teal)"></span> ';
    meta.textContent=`${Math.round(first)}ms · building`;
    stickScroll();
  };
  const msgs=[{role:'system',content:STUDY_SYS},{role:'user',content:`Topic:\n${topic}`}];
  try{
    if(cfg.conn==='demo'){ for await(const c of demoStream('__study',msgs,signal)) onDelta(c) }
    else await chatStream(cfg.studyModel,msgs,{signal,onDelta});
  }catch(err){
    if(err.name==='AbortError'){ body.innerHTML=acc?md(acc)+'<p><em style="color:var(--ink-3)">Stopped.</em></p>':'<em>Stopped.</em>'; meta.textContent='stopped'; return }
    pack.classList.add('err');
    const corsy=/Failed to fetch|NetworkError|Load failed/i.test(err.message);
    body.innerHTML=`<strong style="color:var(--err)">${esc(err.message)}</strong>`+(corsy
      ?`<p style="margin-top:8px">Could not reach <code>${esc(cfg.baseUrl)}</code>. Start the proxy with <code>node server.mjs</code> and pick <b>Local proxy</b>.</p>`:'');
    meta.textContent='failed'; return;
  }
  meta.textContent=`${Math.round(performance.now()-t0)}ms · ${acc.split(/\s+/).filter(Boolean).length}w`;
  renderPack(pack,body,acc,topic);
  remember(topic,acc.slice(0,4000));
  saveRun({mode:'study',prompt:topic,models:[cfg.studyModel],ms:Math.round(performance.now()-t0),
    payload:{model:cfg.studyModel,raw:acc}});
  stickScroll();
}

function splitSections(text){
  const out={}; let cur=null,buf=[];
  text.split('\n').forEach(line=>{
    const m=line.match(/^##\s+([A-Z ]{3,})\s*$/);
    if(m){ if(cur) out[cur]=buf.join('\n').trim(); cur=m[1].trim(); buf=[]; }
    else if(cur) buf.push(line);
  });
  if(cur) out[cur]=buf.join('\n').trim();
  return out;
}
function parseFlashcards(src=''){
  return src.split('\n').map(l=>l.replace(/^[-*\d.)\s]+/,'').trim()).filter(Boolean)
    .map(l=>{const i=l.indexOf('::');return i<0?null:{q:l.slice(0,i).trim(),a:l.slice(i+2).trim()}})
    .filter(x=>x&&x.q&&x.a);
}
function parseQuiz(src=''){
  const items=[]; let cur=null;
  src.split('\n').forEach(raw=>{
    const l=raw.trim(); if(!l) return;
    const am=l.match(/^\**answer\**\s*[:\-]\s*(.+)$/i);
    if(am){ if(cur){cur.a=am[1].trim();items.push(cur);cur=null} return }
    const qm=l.match(/^(?:\d+[.)]|[-*])\s*(.+)$/);
    if(qm){ if(cur) items.push(cur); cur={q:qm[1].replace(/^\**|\**$/g,'').trim(),a:''} }
    else if(cur&&!cur.a) cur.q+=' '+l;
  });
  if(cur) items.push(cur);
  return items.filter(x=>x.q);
}

function renderPack(pack,body,raw,topic){
  const S=splitSections(raw);
  const cards=parseFlashcards(S.FLASHCARDS);
  const quiz=parseQuiz(S.QUIZ);
  const overview=[S.ORIENT&&`## Orientation\n${S.ORIENT}`,S.MAP&&`## Concept map\n${S.MAP}`].filter(Boolean).join('\n\n');
  const core=S.CORE||'';
  const misc=[S.MISCONCEPTIONS&&`## Misconceptions\n${S.MISCONCEPTIONS}`,S.EXAMPLE&&`## Worked example\n${S.EXAMPLE}`].filter(Boolean).join('\n\n');
  const deeper=S['GO DEEPER']||'';

  const panes=[];
  if(overview) panes.push({k:'overview',t:'Overview',html:md(overview)});
  if(core) panes.push({k:'core',t:'Explanation',html:md(core)});
  if(misc) panes.push({k:'traps',t:'Traps & example',html:md(misc)});
  if(cards.length) panes.push({k:'cards',t:`Flashcards · ${cards.length}`,html:''});
  if(quiz.length) panes.push({k:'quiz',t:`Quiz · ${quiz.length}`,html:''});
  if(deeper) panes.push({k:'more',t:'Go deeper',html:md(deeper)});
  if(panes.length<2){ body.innerHTML=md(raw); return; }        // model went off-format: show it plain

  const tabs=document.createElement('div'); tabs.className='packtabs'; tabs.setAttribute('role','tablist');
  const holder=document.createElement('div');
  body.replaceWith(holder); holder.className='packbody';
  pack.appendChild(tabs);

  panes.forEach((p,i)=>{
    const b=document.createElement('button');
    b.textContent=p.t; b.setAttribute('role','tab'); b.setAttribute('aria-selected',String(i===0));
    tabs.appendChild(b);
    const pane=document.createElement('div');
    pane.className='packpane'; pane.hidden=i!==0;
    if(p.k==='cards') pane.appendChild(buildFlashcards(cards));
    else if(p.k==='quiz') pane.appendChild(buildQuiz(quiz));
    else pane.innerHTML=`<div class="body" style="padding:0">${p.html}</div>`;
    holder.appendChild(pane);
    b.onclick=()=>{
      [...tabs.children].forEach((x,j)=>x.setAttribute('aria-selected',String(j===i)));
      [...holder.children].forEach((x,j)=>{x.hidden=j!==i;});
    };
  });
  pack.appendChild(holder);
}
function buildFlashcards(cards){
  const wrap=document.createElement('div'); wrap.className='flashwrap';
  cards.forEach((c,i)=>{
    const b=document.createElement('button');
    b.className='flash'; b.setAttribute('aria-pressed','false'); b.style.animationDelay=(i*45)+'ms';
    b.innerHTML=`<span class="in"><span class="f">${esc(c.q)}</span><span class="b">${esc(c.a)}</span></span>`;
    b.onclick=()=>b.setAttribute('aria-pressed',String(b.getAttribute('aria-pressed')!=='true'));
    wrap.appendChild(b);
  });
  const hint=document.createElement('div');
  hint.style.cssText='grid-column:1/-1;font-size:11.5px;color:var(--ink-3);text-align:center;padding-top:4px';
  hint.textContent='Tap a card to flip it.';
  wrap.appendChild(hint);
  return wrap;
}
function buildQuiz(items){
  const wrap=document.createElement('div'); wrap.className='quiz';
  items.forEach((q,i)=>{
    const el=document.createElement('div'); el.className='qitem';
    el.innerHTML=`<div class="q">${i+1}. ${esc(q.q)}</div><button class="reveal">Show answer</button>`;
    const btn=el.querySelector('.reveal');
    btn.onclick=()=>{
      if(el.querySelector('.a')){el.querySelector('.a').remove();btn.textContent='Show answer';return}
      const a=document.createElement('div'); a.className='a'; a.textContent=q.a||'—';
      el.appendChild(a); btn.textContent='Hide answer';
    };
    wrap.appendChild(el);
  });
  return wrap;
}
</script>
