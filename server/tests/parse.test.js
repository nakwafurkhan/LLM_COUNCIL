import { describe, it, expect } from 'vitest';
import {
  looseJSON, splitSections, parseFlashcards, parseQuiz,
  parseStudyPack, parseHumanized, aggregateReviews
} from '../src/utils/parse.js';
import { scrubSecrets } from '../src/utils/scrub.js';

describe('looseJSON', () => {
  it('reads plain JSON', () => {
    expect(looseJSON('{"a":1}')).toEqual({ a: 1 });
  });
  it('digs JSON out of a fenced block', () => {
    expect(looseJSON('Sure!\n```json\n{"a":2}\n```\n')).toEqual({ a: 2 });
  });
  it('tolerates a trailing comma', () => {
    expect(looseJSON('{"a":3,}')).toEqual({ a: 3 });
  });
  it('returns null when there is no object', () => {
    expect(looseJSON('no json here')).toBeNull();
  });
});

describe('splitSections', () => {
  it('keys content by heading', () => {
    const out = splitSections('## ORIENT\nfirst\n\n## MAP\nsecond');
    expect(out.ORIENT).toBe('first');
    expect(out.MAP).toBe('second');
  });
  it('ignores lowercase headings so prose is not eaten', () => {
    expect(splitSections('## Not A Section\nbody')).toEqual({});
  });
});

describe('flashcards and quiz', () => {
  it('splits on the :: separator', () => {
    const cards = parseFlashcards('What is X? :: A thing\n- Y? :: Another');
    expect(cards).toHaveLength(2);
    expect(cards[1]).toEqual({ q: 'Y?', a: 'Another' });
  });
  it('drops lines with no separator', () => {
    expect(parseFlashcards('just a sentence')).toHaveLength(0);
  });
  it('pairs questions with their answers', () => {
    const quiz = parseQuiz('1. First?\nAnswer: Yes\n2. Second?\nAnswer: No');
    expect(quiz).toEqual([{ q: 'First?', a: 'Yes' }, { q: 'Second?', a: 'No' }]);
  });
});

describe('parseStudyPack', () => {
  it('returns every pane the UI expects', () => {
    const pack = parseStudyPack([
      '## ORIENT', 'why it matters', '',
      '## MAP', '- **Term** — meaning', '',
      '## CORE', 'the explanation', '',
      '## MISCONCEPTIONS', '- Wrong: a → Right: b', '',
      '## EXAMPLE', '1. step', '',
      '## FLASHCARDS', 'Q1 :: A1', 'Q2 :: A2', '',
      '## QUIZ', '1. Q?', 'Answer: A', '',
      '## GO DEEPER', '- a book'
    ].join('\n'));

    expect(pack.orient).toBe('why it matters');
    expect(pack.flashcards).toHaveLength(2);
    expect(pack.quiz).toHaveLength(1);
    expect(pack.goDeeper).toContain('a book');
  });
});

describe('parseHumanized', () => {
  it('separates the four sections', () => {
    const out = parseHumanized('## DRAFT\nd\n\n## TELLS\n- one\n- two\n\n## FINAL\nf\n\n## CHANGES\n- cut X');
    expect(out.draft).toBe('d');
    expect(out.tells).toEqual(['one', 'two']);
    expect(out.final).toBe('f');
    expect(out.changes).toEqual(['cut X']);
  });
  it('falls back to the draft when the model skips FINAL', () => {
    expect(parseHumanized('## DRAFT\nonly a draft').final).toBe('only a draft');
  });
  it('falls back to raw text when the model ignores the format entirely', () => {
    expect(parseHumanized('just a rewrite').final).toBe('just a rewrite');
  });
});

describe('aggregateReviews', () => {
  const seats = [{ index: 0, model: 'a' }, { index: 1, model: 'b' }];

  it('discards a reviewer voting on its own answer', () => {
    const ranking = aggregateReviews({
      seats,
      reviews: [{
        reviewerIndex: 0,
        labelToIndex: { A: 0, B: 1 },
        scores: [
          { label: 'A', accuracy: 10, reasoning: 10, usefulness: 10 },  // self — ignored
          { label: 'B', accuracy: 6, reasoning: 6, usefulness: 6 }
        ]
      }]
    });
    expect(ranking.find(r => r.index === 0).votes).toBe(0);
    expect(ranking.find(r => r.index === 1).mean).toBe(6);
  });

  it('ranks by mean and averages across reviewers', () => {
    const ranking = aggregateReviews({
      seats,
      reviews: [
        { reviewerIndex: 0, labelToIndex: { A: 1 }, scores: [{ label: 'A', accuracy: 8, reasoning: 8, usefulness: 8 }] },
        { reviewerIndex: 1, labelToIndex: { A: 0 }, scores: [{ label: 'A', accuracy: 4, reasoning: 4, usefulness: 4 }] }
      ]
    });
    expect(ranking[0].index).toBe(1);
    expect(ranking[0].rank).toBe(1);
    expect(ranking[1].mean).toBe(4);
  });

  it('survives a reviewer that returned nothing usable', () => {
    const ranking = aggregateReviews({
      seats,
      reviews: [{ reviewerIndex: 0, labelToIndex: { A: 1 }, scores: null }]
    });
    expect(ranking).toHaveLength(2);
    expect(ranking.every(r => r.votes === 0)).toBe(true);
  });
});

describe('scrubSecrets', () => {
  it('drops key-named fields and key-shaped values', () => {
    const out = scrubSecrets({
      theme: 'dark',
      apiKey: 'rsk_live',
      chairModel: 'rsk_pretending_to_be_a_model',
      nested: { token: 'abc', keep: 1 }
    });
    expect(out).toEqual({ theme: 'dark', nested: { keep: 1 } });
  });
});
