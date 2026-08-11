import { streamChat } from '../meshClient.js';
import { HUMANIZE_SYSTEM, voiceClause } from '../prompts.js';
import { parseHumanized } from '../../utils/parse.js';

export async function runHumanize({ prompt, settings, emit, batch, signal }) {
  emit('stage', { stage: 'humanize', label: 'De-slopping' });
  const raw = await streamChat({
    model: settings.humanizeModel,
    messages: [
      { role: 'system', content: HUMANIZE_SYSTEM + voiceClause(settings.voiceSample) },
      { role: 'user', content: `Humanize the following text.\n\n"""\n${prompt}\n"""` }
    ],
    signal,
    onDelta: (delta) => batch.push('main', delta)
  });
  batch.flush();
  return { models: [settings.humanizeModel], humanize: parseHumanized(raw) };
}
