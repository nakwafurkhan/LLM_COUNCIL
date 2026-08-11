<script>
/* ==================== demo mode ==================== */
const DEMO={
  __quick:"**Monorepo, with guardrails.** At twelve people and three services the coordination tax of three repos already outweighs the isolation they buy you.\n\nSet up path-filtered CI on day one and keep deploy pipelines independent per service. Revisit around forty engineers, when CI queueing usually becomes the real pain.\n\n*(Demo mode — canned text. Add a key and run the proxy for the real thing.)*",
  'openai/gpt-4o':"**Short answer: yes, with guardrails.**\n\nAt twelve people and three services, the coordination cost of three repos already outweighs the isolation you get from them. A monorepo buys atomic cross-service changes and one dependency graph.\n\n- Enforce ownership with `CODEOWNERS`, not folder etiquette.\n- Adopt affected-target detection early — Nx, Turborepo, or Bazel if you are polyglot.\n- Keep deploys independent. A shared repo is not a shared release train.\n\nRevisit at roughly forty engineers, when CI queueing becomes the pain point.",
  'anthropic/claude-sonnet-4':"I'd say yes — but honestly, repo layout is rarely what makes or breaks a team this size.\n\nWhat actually helps at twelve people is that a single PR can change a service and its consumer together. That removes an entire category of version-skew bugs.\n\nThe cost is real: CI gets slower unless you invest in selective builds on day one, and tooling gets opinionated fast. If nobody wants to own build infrastructure, three small repos with a shared template will hurt less.",
  'google/gemini-2.5-pro':"**Recommendation: monorepo.**\n\n| Factor | Monorepo | Polyrepo |\n|---|---|---|\n| Cross-service change | One PR | Coordinated PRs |\n| CI cost | Higher without caching | Naturally scoped |\n| Onboarding | One clone | Repo scavenger hunt |\n\nAt three services the polyrepo overhead is pure tax. Set up remote build caching before the first slow-CI complaint, not after.",
  'meta-llama/llama-3.3-70b-instruct':"Yes. Three services, twelve people — a monorepo is the lower-friction choice.\n\n1. One lockfile, one toolchain version.\n2. Path-filtered CI so a docs change does not rebuild everything.\n3. Independent deploy pipelines per service.\n\nThe main risk is treating the monorepo as permission to couple services tightly. Keep module boundaries explicit and the layout stays an implementation detail.",
  __chair:"**Unanimous on the call, split on the caveat.**\n\nAll four seats say monorepo, and the peer scores put the two answers that led with CI economics on top. Where the bench diverges is the failure mode it fears:\n\n- Three members lead with **CI cost** — affected-target builds and remote caching are the price of admission, not a later optimisation.\n- One member raises the sharper point: a monorepo tempts teams into **tight coupling**. That risk is organisational, and no build tool fixes it.\n\n**Verdict:** go monorepo, and treat two things as launch requirements rather than follow-ups — path-filtered CI from the first commit, and independent deploy pipelines per service. If nobody will own build tooling, that is the one honest reason to stay with separate repos.",
  __generic:"*(Demo mode — canned text so you can feel the interface. Add your Mesh key and run the local proxy to hear from the real model.)*\n\nA live seat would answer here, streaming token by token, with first-token latency and word count in the card header. Seats run in parallel and fail independently, so one bad model slug never blocks the bench.",
  __study:`## ORIENT
Bayesian inference is a rule for changing your mind by a fixed amount when evidence arrives. It matters because it is the only coherent way to combine what you already believed with what you just saw — which is most of medicine, spam filtering, and A/B testing.

## MAP
- **Prior** — what you believed before seeing this data, expressed as a distribution.
- **Likelihood** — how probable the observed data is under each possible hypothesis.
- **Posterior** — the updated belief after evidence; the actual output you want.
- **Evidence (marginal likelihood)** — the normalising constant that makes it all sum to one.
- **Conjugacy** — prior and likelihood pairs whose posterior stays in the same family, so the maths closes.
- **Credible interval** — the Bayesian answer to "where is the parameter", unlike a confidence interval.

## CORE
**Plainly:** You start with a hunch, you see some evidence, and you end with a better hunch. Bayes' rule just says exactly how much the evidence should move you — strong evidence moves you a lot, weak evidence barely at all.

**Properly:** Posterior ∝ likelihood × prior. Given data D and hypothesis H, P(H|D) = P(D|H)P(H)/P(D). The likelihood re-weights every point of the prior by how well that hypothesis predicted what actually happened, then everything is renormalised by P(D).

**Deeper:** The posterior is a distribution, not a point, and collapsing it to a mean throws away the thing that made it useful. Priors stop mattering as data accumulates — except in the tails, in hierarchical models, and whenever the likelihood is nearly flat, which is exactly where people quietly rely on defaults they never examined.

## MISCONCEPTIONS
- Wrong: a 95% credible interval and a 95% confidence interval say the same thing → Right: the credible interval is a statement about the parameter; the confidence interval is a statement about the procedure.
- Wrong: priors are unscientific bias → Right: every method has assumptions; Bayesian methods make them explicit and auditable.
- Wrong: a flat prior is "no assumption" → Right: flat in one parameterisation is strongly informative in another.
- Wrong: more data always washes the prior out → Right: not in hierarchical models or under model misspecification.

## EXAMPLE
1. A disease affects 1 in 1,000 people. Prior P(sick) = 0.001.
2. A test has 99% sensitivity and 95% specificity.
3. You test positive. Likelihood of that result if sick = 0.99; if healthy = 0.05.
4. Numerator: 0.99 × 0.001 = 0.00099. Healthy branch: 0.05 × 0.999 = 0.04995.
5. Posterior = 0.00099 / (0.00099 + 0.04995) ≈ 0.019.
6. Despite a "99% accurate" test, you are about 2% likely to be sick. The base rate dominates.

## FLASHCARDS
What does the prior represent? :: Your belief about the parameter before seeing this data.
Write Bayes' rule. :: P(H|D) = P(D|H) · P(H) / P(D)
What is the likelihood a function of? :: The hypothesis, with the data held fixed.
What does P(D) do in the formula? :: Normalises the posterior so it integrates to one.
Credible vs confidence interval? :: Credible is about the parameter; confidence is about the procedure.
Why is conjugacy convenient? :: The posterior stays in the same family, so updates are closed-form.
Conjugate prior for a binomial likelihood? :: The Beta distribution.
When do priors keep mattering? :: Sparse data, tails, hierarchical models, near-flat likelihoods.
What does the disease-test example demonstrate? :: Low base rates dominate even accurate tests.
Is the posterior a number? :: No — a distribution; the mean is only a summary.

## QUIZ
1. A test is 99% sensitive and 95% specific for a condition affecting 1 in 1,000. You test positive. Roughly what is the probability you have it?
Answer: About 2%. The 0.1% base rate overwhelms the test's accuracy, producing far more false positives than true ones.
2. Why is calling a flat prior "uninformative" misleading?
Answer: Flatness is not parameterisation-invariant — uniform on a probability is not uniform on its log-odds.
3. What is the practical difference between a credible and a confidence interval?
Answer: A credible interval states where the parameter probably lies; a confidence interval describes long-run coverage of the procedure.
4. Two labs analyse identical data with different priors and reach different conclusions. Is Bayesian inference broken?
Answer: No — it exposes that the disagreement was in the assumptions, which frequentist framing would have hidden in model choice.
5. When does the choice of prior stop mattering much?
Answer: When the likelihood is sharply peaked relative to the prior — usually plenty of data on a well-specified model.

## GO DEEPER
- *Statistical Rethinking* (McElreath) — the best first book; builds intuition before notation.
- *Bayesian Data Analysis* (Gelman et al.) — the standard reference once you need workflow and diagnostics.
- Stan's user guide — where the theory meets an actual sampler you will run.
- Kruschke's *Doing Bayesian Data Analysis* — strong on the interval-interpretation confusion above.`
};
DEMO.__humanize=`## DRAFT
Our platform helps teams work faster. It handles the coordination overhead that usually eats a project — tracking who owns what, chasing status, keeping the plan honest — so the people doing the work can stay on the work.

That is the whole pitch. No transformation, no journey.

## TELLS
- The rhythm is suspiciously even; every paragraph lands on a tidy closing beat.
- "No transformation, no journey" is a tailing negation, the exact fragment style the original was guilty of.
- The triple "tracking / chasing / keeping" is a rule-of-three wearing a disguise.
- "so the people doing the work can stay on the work" is a neat chiasmus that reads written-to-impress rather than said.
- Zero specifics survived. It is clean, but it says almost nothing a reader could check.

## FINAL
Our platform takes the coordination work off your team. It tracks who owns what and keeps the plan current, so nobody spends Monday morning asking for status.

That is the pitch. It is a project tool, not a transformation.

## CHANGES
- Cut significance inflation: "stands as a testament to innovation", "pivotal".
- Cut promotional gloss: "nestled in the heart of", "groundbreaking", "seamlessly", "unlock their full potential".
- Cut the negative parallelism: "It's not just a tool—it's a catalyst".
- Cut the rule of three: "fostering collaboration, driving efficiency, and enhancing outcomes".
- Replaced the em dash pile-up with plain sentences.
- Swapped "empowering teams" for a concrete claim about status meetings.`;

async function* demoStream(key,messages,signal){
  const last=messages[messages.length-1]?.content;
  const q=typeof last==='string'?last:(last?.[0]?.text||'');
  const sys=typeof messages[0]?.content==='string'?messages[0].content:'';
  let body;
  if(key==='__humanize'||sys.startsWith('You are a ruthless editor')) body=DEMO.__humanize;
  else if(key==='__study'||sys.startsWith('You build rigorous')) body=DEMO.__study;
  else if(key==='__chair'||sys.startsWith('You chair')) body=/monorepo/i.test(q)?DEMO.__chair:DEMO.__generic;
  else if(key==='__quick') body=/monorepo/i.test(q)?DEMO.__quick:DEMO.__generic;
  else body=(/monorepo/i.test(q)&&DEMO[key])?DEMO[key]:DEMO.__generic;

  await sleep(140+Math.random()*380,signal);
  const toks=body.match(/\S+\s*/g)||[];
  const fast=body.length>2500;
  for(const t of toks){
    if(signal.aborted) throw Object.assign(new Error('aborted'),{name:'AbortError'});
    yield t;
    await sleep(fast?2+Math.random()*6:7+Math.random()*22,signal);
  }
}
async function demoPeerJSON(order,good,signal){
  await sleep(500+Math.random()*900,signal);
  const notes=['Clear and well-scoped, though light on the CI cost.','Strongest reasoning; names the organisational risk others miss.','Good structure, but the table oversimplifies the tradeoff.','Correct call, slightly generic in the specifics.'];
  const scores=order.map((oi,pos)=>{
    const base=6.8+Math.random()*2.6;
    return {label:LETTERS[pos],accuracy:Math.min(10,Math.round(base+.4)),reasoning:Math.min(10,Math.round(base)),
      usefulness:Math.min(10,Math.round(base+ (Math.random()>.5?1:0))),critique:notes[oi%notes.length]};
  });
  return JSON.stringify({scores,best:scores[0].label});
}

/* ==================== boot ==================== */
applyTheme();
paintSettings();
setRunMode(cfg.runMode,{silent:true});
paintSuggests();
refreshStatus();
autoGrow();
syncSend();
requestAnimationFrame(positionKnob);
setTimeout(positionKnob,320);
document.fonts?.ready?.then(positionKnob);
if(/localhost|127\.0\.0\.1/.test(location.host)&&cfg.conn==='demo'&&!cfg.apiKey){
  cfg.baseUrl=location.origin+'/v1'; saveCfg(); paintSettings();
}
detectStore().then(pullSettingsIfFresh);
</script>
</body>
</html>
