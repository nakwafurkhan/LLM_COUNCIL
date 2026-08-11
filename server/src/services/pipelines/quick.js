import { streamChat } from '../meshClient.js';

export async function runQuick({ messages, settings, emit, batch, signal }) {
  emit('stage', { stage: 'quick', label: 'Answering' });
  const text = await streamChat({
    model: settings.quickModel,
    messages,
    signal,
    onDelta: (delta) => batch.push('main', delta)
  });
  batch.flush();
  return { models: [settings.quickModel], answer: text };
}
