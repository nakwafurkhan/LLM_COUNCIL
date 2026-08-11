<script>
/* ==================== HUMANIZER ====================
   Based on Wikipedia's "Signs of AI writing" (WikiProject AI Cleanup).
   Three passes in one call: draft → self-audit → final rewrite.        */
const HUMAN_SYS=`You are a ruthless editor who strips AI tells out of writing. You know the Wikipedia "Signs of AI writing" catalogue cold and you edit by ear, not by checklist.

What you cut:
- Significance inflation: "stands as a testament", "marks a pivotal moment", "underscores the importance", "evolving landscape", "leaves an indelible mark", "setting the stage for".
- Promotional gloss: "nestled", "in the heart of", "boasts", "vibrant", "rich cultural heritage", "breathtaking", "groundbreaking", "seamless", "renowned", "unlock the potential".
- Participle padding: clauses tacked on ending in -ing that add no information — "highlighting its role", "reflecting broader trends", "ensuring success", "showcasing", "fostering".
- Copula avoidance: "serves as", "stands as", "functions as", "represents a" where plain "is" works.
- Negative parallelism: "It's not just X, it's Y", "not only... but also". Also clipped tail negations like "no guessing", "no wasted motion".
- Rule of three: forced triplets of adjectives, nouns or clauses used to sound thorough.
- Elegant variation: cycling synonyms for the same subject across sentences.
- False ranges: "from X to Y" where X and Y are not ends of any real scale.
- Vague attribution: "experts argue", "industry observers note", "studies show" with nothing named.
- Em dash spray, boldface sprinkling, emoji bullets, title case headings, curly quotes.
- Filler and hedging: "it is important to note", "in order to", "at this point in time", "could potentially possibly".
- Persuasive authority tropes: "the real question is", "at its core", "what really matters", "fundamentally".
- Signposting: "let's dive in", "here's what you need to know", "without further ado".
- Generic uplift endings: "the future looks bright", "exciting times ahead", "a step in the right direction".
- Chatbot residue: "Great question!", "I hope this helps", "Let me know if...".

What you protect:
- The author's actual claims, facts, numbers, names and intent. Never invent a fact, a statistic, a source or a quote to replace a vague one. If the original is vague, stay vague or cut the sentence — do not fabricate specificity.
- The register. A cover letter stays a cover letter. Do not make formal writing chatty or casual writing stiff.
- Length within reason. Cutting fat is good; gutting content is not.

What you add:
- Varied rhythm. Some short sentences. Some that take longer to arrive.
- A point of view where the genre allows it, and plain honest phrasing where it does not.
- Ordinary words. "use" over "utilise", "about" over "regarding", "has" over "possesses".

Output EXACTLY these four sections, in this order, with these headers and nothing else:

## DRAFT
Your first rewrite, complete.

## TELLS
A short bullet list naming what STILL reads as machine-written in your own draft above. Be specific and unsparing — rhythm too even, contrast too tidy, a phrase that survived, an ending that sounds like a slogan. If a bullet just says "nothing", you are not looking hard enough. Three to five bullets.

## FINAL
The rewrite again, fixing everything you named in TELLS. This is the version the user will actually use. It must read like one person wrote it in one sitting.

## CHANGES
Three to six bullets, each naming the pattern you removed and the phrase it applied to.`;

async function runHumanize(turn,text,signal){
  stageLabel(turn,null,'De-slopping');
  const card=document.createElement('article');
  card.className='human';
  card.innerHTML=`<header>
      <div class="avatar">H</div>
      <div class="cardname">Humanized<span>${esc(cfg.humanizeModel)}</span></div>
      <div class="meta">…</div>
    </header>
    <div class="finalwrap" data-live>
      <div class="progressline"><i style="background:linear-gradient(90deg,transparent,var(--sys-green),transparent)"></i></div>
      <div style="margin-top:12px">
        <div class="skeleton" style="width:93%"></div>
        <div class="skeleton" style="width:81%"></div>
        <div class="skeleton" style="width:62%"></div>
      </div>
    </div>`;
  turn.appendChild(card); stickScroll();

  const live=card.querySelector('[data-live]');
  const meta=card.querySelector('.meta');
  const t0=performance.now();
  let acc='',first=null;

  const onDelta=d=>{
    if(first===null) first=performance.now()-t0;
    acc+=d;
    const stage = /##\s*FINAL/i.test(acc) ? 'writing final'
                : /##\s*TELLS/i.test(acc) ? 'auditing its own draft'
                : 'drafting';
    meta.textContent=stage;
    live.innerHTML=`<div class="finaltext">${md(stripHeaders(acc))}<span class="caret" style="--seatcolor:var(--sys-green)"></span></div>`;
    stickScroll();
  };

  const voice = cfg.voiceSample
    ? `\n\nMatch this author's voice — sentence length, vocabulary level, punctuation habits, how they open and close. Do not imitate their subject matter, only their manner:\n"""\n${cfg.voiceSample.slice(0,2000)}\n"""`
    : '';

  const msgs=[
    {role:'system',content:HUMAN_SYS+voice},
    {role:'user',content:`Humanize the following text.\n\n"""\n${text}\n"""`}
  ];

  try{
    if(cfg.conn==='demo'){ for await(const c of demoStream('__humanize',msgs,signal)) onDelta(c) }
    else await chatStream(cfg.humanizeModel,msgs,{signal,onDelta});
  }catch(err){
    if(err.name==='AbortError'){
      live.innerHTML=acc?`<div class="finaltext">${md(stripHeaders(acc))}</div><p style="color:var(--ink-3);font-size:13px">Stopped.</p>`:'<em style="color:var(--ink-3)">Stopped.</em>';
      meta.textContent='stopped'; return;
    }
    card.style.borderColor='color-mix(in srgb,var(--sys-red) 40%,var(--line))';
    const corsy=/Failed to fetch|NetworkError|Load failed/i.test(err.message);
    live.innerHTML=`<strong style="color:var(--err)">${esc(err.message)}</strong>`+(corsy
      ?`<p style="margin-top:8px;font-size:13px">Could not reach <code>${esc(cfg.baseUrl)}</code>. Start the proxy with <code>node server.mjs</code> and pick <b>Local proxy</b>.</p>`:'');
    meta.textContent='failed'; return;
  }

  meta.textContent=`${Math.round(performance.now()-t0)}ms`;
  renderHumanized(card,live,acc,text);
  remember(text,acc);
  saveRun({mode:'humanize',prompt:text,models:[cfg.humanizeModel],ms:Math.round(performance.now()-t0),
    payload:{model:cfg.humanizeModel,raw:acc}});
  stickScroll();
}

/* while streaming, drop the section headers so the body reads as prose */
function stripHeaders(t){ return t.replace(/^##\s*(DRAFT|TELLS|FINAL|CHANGES)\s*$/gim,'') }

function humanSections(raw){
  const grab=(name)=>{
    const re=new RegExp('##\\s*'+name+'\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)','i');
    const m=raw.match(re); return m?m[1].trim():'';
  };
  return {draft:grab('DRAFT'),tells:grab('TELLS'),final:grab('FINAL'),changes:grab('CHANGES')};
}
const bullets=src=>src.split('\n').map(l=>l.replace(/^[-*•]\s*/,'').trim()).filter(Boolean);
const words=s=>s.split(/\s+/).filter(Boolean).length;

function renderHumanized(card,live,raw,original){
  const S=humanSections(raw);
  const finalText=S.final||S.draft||raw;
  if(!S.final&&!S.draft){ live.innerHTML=`<div class="finaltext">${md(raw)}</div>`; return }

  live.innerHTML=`<div class="finaltext">${md(finalText)}</div>`;

  /* action bar */
  const bar=document.createElement('div');
  bar.className='finalbar';
  bar.innerHTML=`<button class="copybtn" type="button">
      <svg viewBox="0 0 24 24" style="width:14px;height:14px;stroke:currentColor;fill:none;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5.5 15H5a1.8 1.8 0 0 1-1.8-1.8V5A1.8 1.8 0 0 1 5 3.2h8.2A1.8 1.8 0 0 1 15 5v.5"/></svg>
      Copy
    </button>
    <span class="wordstat">${words(original)} words in · ${words(finalText)} out</span>`;
  const copy=bar.querySelector('.copybtn');
  copy.onclick=async()=>{
    try{ await navigator.clipboard.writeText(finalText.trim()) }
    catch{
      const ta=document.createElement('textarea'); ta.value=finalText.trim();
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    copy.classList.add('done'); copy.lastChild.textContent=' Copied';
    setTimeout(()=>{copy.classList.remove('done');copy.lastChild.textContent=' Copy'},1900);
  };
  card.appendChild(bar);

  const section=(title,inner,open)=>{
    const d=document.createElement('details');
    d.className='hsec'; d.open=!!open;
    d.innerHTML=`<summary>${esc(title)}</summary><div class="inner">${inner}</div>`;
    card.appendChild(d);
  };
  if(S.tells){
    const list=bullets(S.tells);
    section(`What still read as AI in the first draft · ${list.length}`,
      `<ul class="tells">${list.map(b=>`<li>${md(b).replace(/^<p>|<\/p>$/g,'')}</li>`).join('')}</ul>`, true);
  }
  if(S.changes){
    const list=bullets(S.changes);
    section(`Patterns removed · ${list.length}`,
      `<ul class="tells">${list.map(b=>`<li>${md(b).replace(/^<p>|<\/p>$/g,'')}</li>`).join('')}</ul>`);
  }
  if(S.draft) section('First draft, before the audit',`<div class="body" style="padding:0">${md(S.draft)}</div>`);
  section('Your original',`<div class="pretext">${esc(original)}</div>`);
}
</script>
