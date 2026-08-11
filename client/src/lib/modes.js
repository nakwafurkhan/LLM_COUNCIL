export const MODES = {
  quick: {
    id: 'quick',
    label: 'Quick',
    tint: 'var(--accent)',
    tag: 'Quick',
    badge: 'Quick mode',
    title: ['Ask once. ', 'Answer now.'],
    sub: 'One fast model, straight to the point. Switch to Council when the answer has to be right, or Study when you need to actually learn it.',
    brandSub: 'One fast model, no ceremony.',
    placeholder: 'Ask anything…',
    cost: '1 call',
    suggestions: [
      ['Quick fact', 'What actually changed in HTTP/3 versus HTTP/2?'],
      ['Compress it', 'Explain quantum computing in one sentence.'],
      ['Fix my wording', 'Rewrite this to be one line shorter and less corporate: "We are excited to announce…"'],
      ['Small decision', 'Postgres or SQLite for a single-node internal tool with 20 users?']
    ]
  },
  council: {
    id: 'council',
    label: 'Council',
    tint: 'var(--chair)',
    tag: 'Council',
    badge: 'Council mode · 3 stages',
    title: ['Ask once. ', 'Hear the bench.'],
    sub: 'Every seat answers in parallel, scores the others blind, and the chair turns the disagreement into one verdict.',
    brandSub: 'Deliberate, review, synthesize.',
    placeholder: 'Put a question to the council…',
    suggestions: [
      ['Take a position', 'Is a monorepo the right call for a 12-person product team shipping three services?'],
      ['Stress-test a claim', 'Is intermittent fasting actually better than plain calorie restriction?'],
      ['Judge a tradeoff', 'Should a seed-stage startup build on Kubernetes or a PaaS? Argue it properly.'],
      ['Compare voices', 'Write a tight 80-word launch note for a developer tool that routes to 900+ models through one key.']
    ]
  },
  study: {
    id: 'study',
    label: 'Study',
    tint: 'var(--sys-teal)',
    tag: 'Deep study',
    badge: 'Deep study mode',
    title: ['Paste a topic. ', 'Learn it properly.'],
    sub: 'You get an orientation, a concept map, a layered explanation, the misconceptions that trip people up, flashcards you can flip, and a quiz to check yourself.',
    brandSub: 'Concepts, flashcards, self-check.',
    placeholder: 'Paste a topic — "Bayesian inference", "the Krebs cycle", "how TLS handshakes work"…',
    cost: '1 call · long',
    suggestions: [
      ['Foundations', 'Bayesian inference — priors, likelihood, and why the posterior is the point'],
      ['Systems', 'How TLS 1.3 handshakes work, end to end'],
      ['Biology', 'The Krebs cycle and why it matters for energy metabolism'],
      ['Money', 'Duration and convexity in bond pricing']
    ]
  },
  humanize: {
    id: 'humanize',
    label: 'Humanize',
    tint: 'var(--sys-green)',
    tag: 'Humanize',
    badge: 'Humanizer',
    title: ['Paste the slop. ', 'Get your voice back.'],
    sub: 'It strips the tells — significance inflation, participle padding, rule-of-three, em dash spray, "not just X, but Y" — then audits its own draft and rewrites what still reads like a machine.',
    brandSub: 'Strip the AI tells.',
    placeholder: 'Paste the text you want de-slopped…',
    cost: '1 call · draft, audit, rewrite',
    suggestions: [
      ['Try a bad paragraph', "Nestled in the heart of the evolving AI landscape, our groundbreaking platform stands as a testament to innovation, seamlessly empowering teams to unlock their full potential. It's not just a tool—it's a catalyst for transformation, fostering collaboration, driving efficiency, and enhancing outcomes across the organization."],
      ['LinkedIn voice', "I'm thrilled to announce that I've joined Acme as a Senior Product Manager! This pivotal moment marks an exciting new chapter in my professional journey. I'm deeply grateful to my mentors, whose guidance underscored the importance of resilience."],
      ['Cover letter', 'I am writing to express my strong interest in this role. With a proven track record of delivering data-driven, cross-functional results, I am confident that my unique blend of skills would make me a valuable addition to your dynamic team.'],
      ['Doc intro', "In today's rapidly evolving technological landscape, understanding authentication has become increasingly crucial. This comprehensive guide will delve into the intricacies of OAuth, exploring its key components and highlighting best practices."]
    ]
  }
};

export const MODE_LIST = Object.values(MODES);

export const councilCost = (seatCount, peerReview) =>
  `${seatCount + (peerReview ? seatCount : 0) + 1} calls · ~${Math.max(3, seatCount)}×`;
