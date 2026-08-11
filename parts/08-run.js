<script>
/* ==================== dispatch ==================== */
async function submit(){
  const text=input.value.trim(); const img=attachment;
  if(!text&&!img) return;
  input.value=''; autoGrow(); setAttachment(null); syncSend();
  if(heroNode.parentNode) heroNode.remove();

  const mode=cfg.runMode;
  const turn=document.createElement('section'); turn.className='turn';
  const tint=mode==='council'?'var(--chair)':mode==='study'?'var(--sys-teal)':'var(--accent)';
  const tag={quick:'⚡ Quick',council:'⚖︎ Council',study:'✦ Deep study',humanize:'✎ Humanize'}[mode];
  turn.innerHTML=`<div class="usermsg"><div class="bubble">
      <div class="modetag">${tag}</div>
      ${img?`<img src="${esc(img.url)}" alt="attached">`:''}${esc(text)||'<em>(image only)</em>'}
    </div></div>`;
  $('#wrap').appendChild(turn); stick=true; stickScroll();

  const signal=startRun();
  try{
    if(mode==='quick') await runQuick(turn,text,img,signal);
    else if(mode==='study') await runStudy(turn,text,signal);
    else if(mode==='humanize') await runHumanize(turn,text,signal);
    else await runCouncil(turn,text,img,signal);
  }finally{
    stopRun(); stickScroll();
  }
}

/* ==================== QUICK ==================== */
async function runQuick(turn,text,img,signal){
  const {msgs,userContent}=buildMessages(text,img);
  const t0=performance.now();
  const card=makeCard(turn,cfg.quickModel,'var(--accent)');
  const r=await streamInto(card,cfg.quickModel,msgs,signal,'__quick');
  if(r.ok){
    remember(userContent,r.text);
    saveRun({mode:'quick',prompt:text,models:[cfg.quickModel],ms:Math.round(performance.now()-t0),
      payload:{model:cfg.quickModel,text:r.text,image:img?img.url:''}});
  }
}

/* ==================== COUNCIL ==================== */
async function runCouncil(turn,text,img,signal){
  const seats=cfg.seats.filter(s=>s.on&&s.model);
  if(!seats.length){toast('No seats enabled — open Settings');return}
  if(seats.length===1){                                  // a council of one is just Quick
    const {msgs,userContent}=buildMessages(text,img);
    const card=makeCard(turn,seats[0].model,seatColor(0));
    const r=await streamInto(card,seats[0].model,msgs,signal);
    if(r.ok) remember(userContent,r.text);
    return;
  }
  const {msgs,userContent}=buildMessages(text,img);
  const t0=performance.now();
  const record={mode:'council',prompt:text,models:seats.map(s=>s.model),
    payload:{seats:[],ranking:null,chair:null,image:img?img.url:''}};

  /* ---- Stage 1: deliberation ---- */
  const lab1=stageLabel(turn,'1','Deliberation',`0/${seats.length} in`);
  const grid=document.createElement('div'); grid.className='grid'; turn.appendChild(grid);
  const cards=seats.map((s,i)=>{const c=makeCard(grid,s.model,seatColor(i));c.el.style.animationDelay=(i*60)+'ms';return c});
  let done=0;
  const answers=await Promise.all(seats.map((s,i)=>
    streamInto(cards[i],s.model,msgs,signal,s.model).finally(()=>{
      done++; const l=lab1.querySelector('[data-live]'); if(l) l.textContent=`${done}/${seats.length} in`;
    })
  ));
  const good=answers.map((a,i)=>({...a,idx:i,color:seatColor(i)})).filter(a=>a.ok&&a.text.trim());
  record.payload.seats=seats.map((s,i)=>({model:s.model,text:answers[i]?.text||''}));
  if(signal.aborted||!good.length) return;

  /* ---- Stage 2: anonymous peer review ---- */
  let ranking=null;
  if(cfg.peer&&good.length>1){
    const lab2=stageLabel(turn,'2','Anonymous peer review',`0/${good.length} reviewed`);
    const board=document.createElement('div'); board.className='board';
    board.innerHTML='<div style="padding:12px 13px"><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:52%"></div></div>';
    turn.appendChild(board); stickScroll();
    ranking=await peerReview(text,good,cards,signal,n=>{
      const l=lab2.querySelector('[data-live]'); if(l) l.textContent=`${n}/${good.length} reviewed`;
    });
    if(signal.aborted) return;
    renderBoard(board,ranking,good);
    record.payload.ranking=ranking.map(({color,...r})=>r);
  }

  /* ---- Stage 3: chairman ---- */
  if(cfg.chair&&cfg.chair!=='none'&&!signal.aborted){
    stageLabel(turn,'3','Chairman synthesis');
    const vcard=makeCard(turn,cfg.chair,'var(--chair)','chair');
    const brief=good.map((r,i)=>{
      const rank=ranking?ranking.find(x=>x.idx===r.idx):null;
      const score=rank?` — peer score ${rank.mean.toFixed(1)}/10, ranked #${rank.rank}`:'';
      return `### Member ${i+1} (${r.model})${score}\n${r.text}`;
    }).join('\n\n');
    const critiques=ranking
      ? '\n\nPeer critiques:\n'+ranking.flatMap(r=>r.comments.map(c=>`- on ${shortName(r.model)}: ${c}`)).join('\n')
      : '';
    const sys="You chair a council of AI models. You receive the original question, each member's answer, and — where available — the anonymous peer scores and critiques they gave each other. Deliver a decisive verdict: where the bench genuinely agrees, where it diverges and why that matters, and your own recommendation. Weigh the peer scores but do not defer to them blindly. Never simply summarise each answer in turn.";
    const r=await streamInto(vcard,cfg.chair,[
      {role:'system',content:sys},
      {role:'user',content:`Question put to the council:\n${text||'(image attached)'}\n\n${brief}${critiques}`}
    ],signal,'__chair');
    if(r.ok){ remember(userContent,r.text); record.payload.chair={model:cfg.chair,text:r.text} }
  }else{
    remember(userContent,good.map(r=>`[${r.model}] ${r.text}`).join('\n\n---\n\n'));
  }
  record.ms=Math.round(performance.now()-t0);
  saveRun(record);
}

/* ---- stage 2 mechanics ---- */
const LETTERS='ABCDEFGH';
async function peerReview(question,good,cards,signal,onProgress){
  let n=0;
  const reviews=await Promise.all(good.map(async reviewer=>{
    /* shuffle so label order differs per reviewer; authorship never disclosed */
    const order=good.map((g,i)=>i).sort(()=>Math.random()-0.5);
    const label2idx={};
    const blocks=order.map((oi,pos)=>{
      const L=LETTERS[pos]; label2idx[L]=good[oi].idx;
      return `### Response ${L}\n${good[oi].text}`;
    }).join('\n\n');
    const sys="You are grading anonymous answers to a question. Authorship is hidden and one of them may be your own — judge only the content. Reply with JSON only.";
    const user=`Question:\n${question||'(image attached)'}\n\n${blocks}\n\n`+
      `Score every response from 1-10 on accuracy, reasoning and usefulness, and add one short sentence of critique. `+
      `Reply with exactly this JSON shape:\n`+
      `{"scores":[{"label":"A","accuracy":0,"reasoning":0,"usefulness":0,"critique":""}],"best":"A"}`;
    let parsed=null;
    try{
      const raw = cfg.conn==='demo'
        ? await demoPeerJSON(order,good,signal)
        : await chatOnce(reviewer.model,[{role:'system',content:sys},{role:'user',content:user}],{signal,json:true});
      parsed=looseJSON(raw);
    }catch(e){ if(e.name==='AbortError') throw e }
    n++; onProgress?.(n);
    return {reviewer:reviewer.idx,label2idx,parsed};
  }));
  if(signal.aborted) return [];

  /* aggregate, excluding self-votes */
  const agg=new Map(good.map(g=>[g.idx,{idx:g.idx,model:g.model,color:g.color,sum:0,count:0,comments:[]}]));
  reviews.forEach(rv=>{
    const rows=rv.parsed?.scores; if(!Array.isArray(rows)) return;
    rows.forEach(row=>{
      const target=rv.label2idx[String(row.label||'').trim().toUpperCase()];
      if(target===undefined) return;
      if(target===rv.reviewer) return;                       // drop self-scoring
      const nums=[row.accuracy,row.reasoning,row.usefulness].map(Number).filter(x=>x>=0&&x<=10&&!isNaN(x));
      if(!nums.length) return;
      const e=agg.get(target); if(!e) return;
      e.sum+=nums.reduce((a,b)=>a+b,0)/nums.length; e.count++;
      if(row.critique) e.comments.push(String(row.critique).trim());
    });
  });
  const out=[...agg.values()].map(e=>({...e,mean:e.count?e.sum/e.count:0}))
    .sort((a,b)=>b.mean-a.mean)
    .map((e,i)=>({...e,rank:i+1}));

  /* badge each seat card */
  out.forEach(r=>{
    const card=cards[r.idx]; if(!card||!r.count) return;
    const chip=document.createElement('span');
    chip.className='scorechip'+(r.rank===1?' top':'');
    chip.textContent=(r.rank===1?'★ ':'#'+r.rank+' ')+r.mean.toFixed(1);
    card.meta.parentNode.insertBefore(chip,card.meta);
  });
  return out;
}
function renderBoard(board,ranking,good){
  if(!ranking||!ranking.length||!ranking.some(r=>r.count)){
    board.innerHTML='<div style="padding:12px 14px;font-size:12.8px;color:var(--ink-3)">Peer review returned no usable scores — the chair will weigh the answers unaided.</div>';
    return;
  }
  board.innerHTML='';
  const max=Math.max(...ranking.map(r=>r.mean),1);
  ranking.forEach((r,i)=>{
    const row=document.createElement('div');
    row.className='brow'; row.style.setProperty('--seatcolor',r.color); row.style.animationDelay=(i*70)+'ms';
    row.innerHTML=`<span class="rank">${r.rank===1?'★':r.rank}</span>
      <span class="who">${esc(shortName(r.model))}</span>
      <span class="bar"><i></i></span>
      <span class="num">${r.count?r.mean.toFixed(1)+'/10':'—'}</span>
      <button class="peek" aria-expanded="false" aria-label="Show critiques">⌄</button>`;
    board.appendChild(row);
    requestAnimationFrame(()=>{row.querySelector('.bar i').style.width=(r.mean/max*100)+'%'});
    const crit=document.createElement('div');
    crit.className='critiques'; crit.hidden=true;
    crit.innerHTML=r.comments.length
      ? r.comments.map(c=>`<div>${esc(c)}</div>`).join('')
      : '<div>No written critique returned.</div>';
    board.appendChild(crit);
    const peek=row.querySelector('.peek');
    peek.onclick=()=>{const open=peek.getAttribute('aria-expanded')==='true';
      peek.setAttribute('aria-expanded',String(!open)); crit.hidden=open};
  });
  const foot=document.createElement('div');
  foot.style.cssText='padding:7px 13px 9px;font-size:11.5px;color:var(--ink-3)';
  foot.textContent='Scores are means of the other seats only — self-votes are discarded.';
  board.appendChild(foot);
}
</script>
