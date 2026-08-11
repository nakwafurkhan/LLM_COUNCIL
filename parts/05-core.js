<script>
/* ==================== state ==================== */
const SEAT_COLORS=['#007aff','#ff9500','#30b0c7','#af52de','#ff2d55','#34c759','#5856d6','#a2845e'];
const uid=()=>Math.random().toString(36).slice(2,9);
const DEFAULTS={
  runMode:'quick',
  conn:'demo',
  baseUrl:'http://localhost:8787/v1',
  apiKey:'',
  imgSource:'openverse',
  quickModel:'openai/gpt-4o-mini',
  studyModel:'openai/gpt-4o',
  humanizeModel:'anthropic/claude-sonnet-4',
  voiceSample:'',
  chair:'openai/gpt-4o',
  peer:true,
  seats:[
    {id:uid(),model:'openai/gpt-4o',on:true},
    {id:uid(),model:'anthropic/claude-sonnet-4',on:true},
    {id:uid(),model:'google/gemini-2.5-pro',on:true},
    {id:uid(),model:'meta-llama/llama-3.3-70b-instruct',on:true}
  ],
  system:"Answer directly and concisely. State a position; flag real uncertainty rather than hedging everywhere.",
  ctxTurns:3,
  theme:'light'
};
function loadCfg(){
  try{
    const raw=JSON.parse(localStorage.getItem('llm-council-v2')||'{}');
    const c={...structuredClone(DEFAULTS),...raw};
    if(!Array.isArray(c.seats)||!c.seats.length) c.seats=structuredClone(DEFAULTS.seats);
    return c;
  }catch{ return structuredClone(DEFAULTS) }
}
let cfg=loadCfg();
const saveCfg=()=>{
  localStorage.setItem('llm-council-v2',JSON.stringify(cfg));
  if(typeof pushSettings==='function') pushSettings();   // mirror to the server, minus the key
};

let convo=[];            // rolling chat memory
let attachment=null;     // {url,name}
let running=null;        // AbortController

const $=q=>document.querySelector(q);
const $$=q=>[...document.querySelectorAll(q)];
const esc=t=>String(t).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const seatColor=i=>SEAT_COLORS[i%SEAT_COLORS.length];
const shortName=m=>{const t=(m||'').split('/').pop().replace(/-(latest|preview)$/,'');return t.length>24?t.slice(0,23)+'…':t};
const initials=m=>(m||'?').split('/').pop().replace(/[^a-z0-9]/gi,'').slice(0,2).toUpperCase();
const sleep=(ms,signal)=>new Promise((res,rej)=>{
  const id=setTimeout(res,ms);
  signal?.addEventListener('abort',()=>{clearTimeout(id);rej(Object.assign(new Error('aborted'),{name:'AbortError'}))},{once:true});
});

/* ==================== markdown ==================== */
function md(src){
  let t=esc(src);
  const blocks=[];
  t=t.replace(/```(\w*)\n?([\s\S]*?)```/g,(_,l,c)=>{blocks.push(c);return `\n\n@@CB${blocks.length-1}@@\n\n`});
  t=t.replace(/^\|(.+)\|[ \t]*\n\|[ \t:\-|]+\|[ \t]*\n((?:\|.*\|[ \t]*\n?)+)/gm,(m,head,rows)=>{
    const cells=r=>r.split('|').slice(1,-1).map(c=>c.trim());
    const th=cells('|'+head+'|').map(c=>`<th>${c}</th>`).join('');
    const tb=rows.trim().split('\n').map(r=>'<tr>'+cells(r).map(c=>`<td>${c}</td>`).join('')+'</tr>').join('');
    return `<table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table>\n\n`;
  });
  t=t.replace(/`([^`\n]+)`/g,'<code>$1</code>')
     .replace(/^####\s+(.+)$/gm,'<h3>$1</h3>')
     .replace(/^###\s+(.+)$/gm,'<h3>$1</h3>')
     .replace(/^##\s+(.+)$/gm,'<h2>$1</h2>')
     .replace(/^#\s+(.+)$/gm,'<h2>$1</h2>')
     .replace(/^&gt;\s?(.+)$/gm,'<blockquote>$1</blockquote>')
     .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
     .replace(/(^|[\s(])\*([^*\n]+)\*/g,'$1<em>$2</em>')
     .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,'<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t=t.replace(/(?:^[-*+]\s+.+(?:\n|$))+/gm,m=>'<ul>'+m.trim().split('\n').map(l=>`<li>${l.replace(/^[-*+]\s+/,'')}</li>`).join('')+'</ul>');
  t=t.replace(/(?:^\d+\.\s+.+(?:\n|$))+/gm,m=>'<ol>'+m.trim().split('\n').map(l=>`<li>${l.replace(/^\d+\.\s+/,'')}</li>`).join('')+'</ol>');
  t=t.split(/\n{2,}/).map(p=>{
      const x=p.trim(); if(!x) return '';
      return /^<(h\d|ul|ol|pre|blockquote|table)/.test(x)?x:`<p>${x.replace(/\n/g,'<br>')}</p>`;
    }).join('');
  t=t.replace(/<p>\s*(@@CB\d+@@)\s*<\/p>/g,'$1');
  return t.replace(/@@CB(\d+)@@/g,(_,i)=>`<pre><code>${blocks[i].replace(/\n$/,'')}</code></pre>`);
}

/* ==================== chrome ==================== */
function applyTheme(){
  document.documentElement.dataset.theme=cfg.theme;
  $('#themeIcon').innerHTML = cfg.theme==='dark'
    ? '<path d="M20.4 14.2A8.4 8.4 0 0 1 9.8 3.6a8.4 8.4 0 1 0 10.6 10.6z"/>'
    : '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.1 5.1l1.4 1.4M17.5 17.5l1.4 1.4M18.9 5.1l-1.4 1.4M6.5 17.5l-1.4 1.4"/>';
}
function toast(msg){
  const el=$('#toast'); el.textContent=msg; el.classList.add('on');
  clearTimeout(el._t); el._t=setTimeout(()=>el.classList.remove('on'),2500);
}
function refreshStatus(){
  const dot=$('#statusDot'),txt=$('#statusText');
  dot.className='dot '+(cfg.conn==='demo'?'demo':(cfg.apiKey?'live':'bad'));
  txt.textContent = cfg.conn==='demo'?'Demo':(cfg.apiKey?(cfg.conn==='proxy'?'Proxy':'Direct'):'No key');
  const seats=cfg.seats.filter(s=>s.on&&s.model).length;
  const c=$('#costHint');
  if(cfg.runMode==='quick') c.textContent='1 call';
  else if(cfg.runMode==='study') c.textContent='1 call · long';
  else if(cfg.runMode==='humanize') c.textContent=cfg.voiceSample?'1 call · voice-matched':'1 call · draft, audit, rewrite';
  else c.textContent=`${seats + (cfg.peer?seats:0) + 1} calls · ~${Math.max(3,seats)}×`;
}

/* ---- sheets ---- */
function openPanel(sel){
  $$('.panel').forEach(p=>{p.classList.remove('on');p.setAttribute('aria-hidden','true')});
  const p=$(sel); p.classList.add('on'); p.setAttribute('aria-hidden','false'); $('#scrim').classList.add('on');
}
function closePanels(){
  $$('.panel').forEach(p=>{p.classList.remove('on');p.setAttribute('aria-hidden','true')});
  $('#scrim').classList.remove('on');
}
$('#scrim').onclick=closePanels;
$$('[data-close]').forEach(b=>b.onclick=closePanels);
$('#btnSettings').onclick=()=>openPanel('#settingsPanel');
$('#btnImages').onclick=()=>{openPanel('#imgPanel');setTimeout(()=>$('#imgQuery').focus(),300)};
$('#btnPlus').onclick=()=>$('#btnImages').click();
$('#statusPill').onclick=()=>openPanel('#settingsPanel');
$('#btnTheme').onclick=()=>{cfg.theme=cfg.theme==='dark'?'light':'dark';saveCfg();applyTheme()};
$$('.tabs button').forEach(b=>b.onclick=()=>{
  $$('.tabs button').forEach(x=>x.setAttribute('aria-selected',String(x===b)));
  $$('[data-pane]').forEach(p=>p.hidden=p.dataset.pane!==b.dataset.tab);
});
addEventListener('keydown',e=>{
  if(e.key==='Escape') closePanels();
  const meta=e.metaKey||e.ctrlKey;
  if(!meta) return;
  const k=e.key.toLowerCase();
  if(k==='k'){e.preventDefault();openPanel('#settingsPanel')}
  if(k==='i'){e.preventDefault();$('#btnImages').click()}
  if(k==='h'){e.preventDefault();$('#btnHistory').click()}
  if(k==='1'){e.preventDefault();setRunMode('quick')}
  if(k==='2'){e.preventDefault();setRunMode('council')}
  if(k==='3'){e.preventDefault();setRunMode('study')}
  if(k==='4'){e.preventDefault();setRunMode('humanize')}
});

/* ==================== mode switch ==================== */
const MODES={
  quick:{
    badge:'Quick mode', title:'Ask once. <em>Answer now.</em>',
    sub:'One fast model, straight to the point. Switch to Council when the answer has to be right, or Study when you need to actually learn it.',
    placeholder:'Ask anything…', sub2:'One fast model, no ceremony.',
    sugs:[
      ['Quick fact','What actually changed in HTTP/3 versus HTTP/2?'],
      ['Compress it','Explain quantum computing in one sentence.'],
      ['Fix my wording','Rewrite this to be one line shorter and less corporate: "We are excited to announce…"'],
      ['Small decision','Postgres or SQLite for a single-node internal tool with 20 users?']
    ]
  },
  council:{
    badge:'Council mode · 3 stages', title:'Ask once. <em>Hear the bench.</em>',
    sub:'Every seat answers in parallel, scores the others blind, and the chair turns the disagreement into one verdict.',
    placeholder:'Put a question to the council…', sub2:'Deliberate, review, synthesize.',
    sugs:[
      ['Take a position','Is a monorepo the right call for a 12-person product team shipping three services?'],
      ['Stress-test a claim','Is intermittent fasting actually better than plain calorie restriction?'],
      ['Judge a tradeoff','Should a seed-stage startup build on Kubernetes or a PaaS? Argue it properly.'],
      ['Compare voices','Write a tight 80-word launch note for a developer tool that routes to 900+ models through one key.']
    ]
  },
  study:{
    badge:'Deep study mode', title:'Paste a topic. <em>Learn it properly.</em>',
    sub:'You get an orientation, a concept map, a layered explanation, the misconceptions that trip people up, flashcards you can flip, and a quiz to check yourself.',
    placeholder:'Paste a topic — "Bayesian inference", "the Krebs cycle", "how TLS handshakes work"…',
    sub2:'Concepts, flashcards, self-check.',
    sugs:[
      ['Foundations','Bayesian inference — priors, likelihood, and why the posterior is the point'],
      ['Systems','How TLS 1.3 handshakes work, end to end'],
      ['Biology','The Krebs cycle and why it matters for energy metabolism'],
      ['Money','Duration and convexity in bond pricing']
    ]
  },
  humanize:{
    badge:'Humanizer', title:'Paste the slop. <em>Get your voice back.</em>',
    sub:'It strips the tells — significance inflation, participle padding, rule-of-three, em dash spray, "not just X, but Y" — then audits its own draft and rewrites what still reads like a machine.',
    placeholder:'Paste the text you want de-slopped…',
    sub2:'Strip the AI tells.',
    sugs:[
      ['Try a bad paragraph',"Nestled in the heart of the evolving AI landscape, our groundbreaking platform stands as a testament to innovation, seamlessly empowering teams to unlock their full potential. It's not just a tool—it's a catalyst for transformation, fostering collaboration, driving efficiency, and enhancing outcomes across the organization."],
      ['LinkedIn voice',"I'm thrilled to announce that I've joined Acme as a Senior Product Manager! This pivotal moment marks an exciting new chapter in my professional journey. I'm deeply grateful to my mentors, whose guidance underscored the importance of resilience. Excited for what lies ahead!"],
      ['Cover letter',"I am writing to express my strong interest in this role. With a proven track record of delivering data-driven, cross-functional results, I am confident that my unique blend of skills would make me a valuable addition to your dynamic team."],
      ['Doc intro',"In today's rapidly evolving technological landscape, understanding authentication has become increasingly crucial. This comprehensive guide will delve into the intricacies of OAuth, exploring its key components and highlighting best practices."]
    ]
  }
};
function positionKnob(){
  const sw=$('#modeSwitch'), knob=$('#modeKnob');
  const active=sw.querySelector('button[aria-pressed=true]'); if(!active) return;
  /* rects, not offsetLeft — integer rounding leaves the knob a pixel or two off */
  const a=active.getBoundingClientRect(), s=sw.getBoundingClientRect();
  knob.style.width=a.width+'px';
  knob.style.transform=`translateX(${a.left-s.left-2.5}px)`;
}
function setRunMode(m,{silent}={}){
  cfg.runMode=m; saveCfg();
  document.body.dataset.run=m;
  const sw=$('#modeSwitch'); sw.dataset.mode=m;
  sw.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.run===m)));
  positionKnob();
  const c=MODES[m];
  $('#input').placeholder=c.placeholder;
  $('#brandSub').textContent=c.sub2;
  const hero=$('#hero');
  if(hero){
    $('#heroBadge').textContent=c.badge;
    $('#heroTitle').innerHTML=c.title;
    $('#heroSub').textContent=c.sub;
    hero.style.animation='none'; void hero.offsetWidth; hero.style.animation='';
    paintSuggests();
  }
  refreshStatus();
  if(!silent) toast(m==='quick'?'Quick — one fast model'
    :m==='council'?'Council — three stages'
    :m==='study'?'Deep study'
    :'Humanizer — draft, audit, rewrite');
}
function paintSuggests(){
  const box=$('#heroSuggests'); if(!box) return;
  box.innerHTML='';
  MODES[cfg.runMode].sugs.forEach(([t,q])=>{
    const b=document.createElement('button');
    b.className='sug'; b.innerHTML=`<b>${esc(t)}</b>${esc(q)}`;
    b.onclick=()=>{const i=$('#input');i.value=q;autoGrow();syncSend();i.focus()};
    box.appendChild(b);
  });
}
$$('#modeSwitch button').forEach(b=>b.onclick=()=>setRunMode(b.dataset.run));
addEventListener('resize',positionKnob);
</script>
