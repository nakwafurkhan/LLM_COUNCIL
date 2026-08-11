import { streamChat } from '../meshClient.js';
import { STUDY_SYSTEM } from '../prompts.js';
import { parseStudyPack } from '../../utils/parse.js';

export async function runStudy({ prompt, settings, emit, batch, signal }) {
  emit('stage', { stage: 'study', label: 'Building your study pack' });
  const raw = await streamChat({
    model: settings.studyModel,
    messages: [
      { role: 'system', content: STUDY_SYSTEM },
      { role: 'user', content: `Topic:\n${prompt}` }
    ],
    signal,
    onDelta: (delta) => batch.push('main', delta)
  });
  batch.flush();
  /* Parsed here so history replay is a pure render and the client owns no
     duplicate of this logic. */
  return { models: [settings.studyModel], study: parseStudyPack(raw) };
}
