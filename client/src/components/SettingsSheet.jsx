import { memo, useState } from 'react';
import { Sheet, Field, Switch } from './Sheet.jsx';
import { api } from '../lib/api.js';
import { seatColor } from '../lib/markdown.js';

const TABS = [
  ['models', 'Models'],
  ['behaviour', 'Behaviour'],
  ['about', 'About']
];

function SeatRow({ value, index, onChange, onRemove }) {
  return (
    <div className="seat">
      <span className="sw" style={{ background: seatColor(index) }} />
      <input
        type="text"
        className="mono"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button className="del" aria-label="Remove seat" onClick={onRemove}>✕</button>
    </div>
  );
}

export const SettingsSheet = memo(function SettingsSheet({ open, onClose, settings, update, notify }) {
  const [tab, setTab] = useState('models');
  const [newSeat, setNewSeat] = useState('');
  const [check, setCheck] = useState(null);

  const runCheck = async () => {
    setCheck({ state: 'busy', message: 'Checking…' });
    try {
      const [health, mesh] = await Promise.all([api.health(), api.meshCheck()]);
      setCheck({
        state: 'ok',
        message: `Connected. ${mesh.models} models visible, MongoDB ${health.db.state}.`
      });
    } catch (err) {
      setCheck({ state: 'bad', message: err.message });
    }
  };

  const setSeat = (i, value) => update((s) => {
    const seats = [...s.seats];
    seats[i] = value;
    return { ...s, seats };
  });

  const addSeat = () => {
    const slug = newSeat.trim();
    if (!slug) return;
    update((s) => ({ ...s, seats: [...s.seats, slug] }));
    setNewSeat('');
  };

  return (
    <Sheet open={open} title="Settings" onClose={onClose}>
      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'models' && (
        <>
          <Field label="Quick model" hint="One call, streamed straight back.">
            <input
              type="text" className="mono" spellCheck={false}
              value={settings.quickModel}
              onChange={(e) => update({ quickModel: e.target.value })}
            />
          </Field>

          <Field label="Council seats" hint="Every seat answers in parallel, then reviews the others anonymously.">
            {settings.seats.map((seat, i) => (
              <SeatRow
                key={i}
                index={i}
                value={seat}
                onChange={(v) => setSeat(i, v)}
                onRemove={() => update((s) => ({ ...s, seats: s.seats.filter((_, j) => j !== i) }))}
              />
            ))}
            <div className="row" style={{ marginTop: 10 }}>
              <input
                type="text" className="mono" placeholder="provider/model-slug" spellCheck={false}
                style={{ flex: 1 }}
                value={newSeat}
                onChange={(e) => setNewSeat(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addSeat()}
              />
              <button className="btn" onClick={addSeat}>Add</button>
            </div>
          </Field>

          <Field>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <label style={{ margin: 0 }}>Stage 2 — peer review</label>
                <div className="desc" style={{ margin: '2px 0 0' }}>
                  Seats score each other blind. Doubles seat calls.
                </div>
              </div>
              <Switch
                checked={settings.peerReview}
                onChange={(v) => update({ peerReview: v })}
                label="Peer review"
              />
            </div>
          </Field>

          <Field label="Chair model" hint="Reads every answer plus the rankings and writes the verdict.">
            <input
              type="text" className="mono" spellCheck={false}
              value={settings.chairModel}
              onChange={(e) => update({ chairModel: e.target.value })}
            />
          </Field>

          <Field label="Study model" hint="Builds the study pack: concepts, misconceptions, flashcards, quiz.">
            <input
              type="text" className="mono" spellCheck={false}
              value={settings.studyModel}
              onChange={(e) => update({ studyModel: e.target.value })}
            />
          </Field>

          <Field label="Humanizer model" hint="Wants a strong model — the self-audit pass is the point.">
            <input
              type="text" className="mono" spellCheck={false}
              value={settings.humanizeModel}
              onChange={(e) => update({ humanizeModel: e.target.value })}
            />
          </Field>

          <Field>
            <button className="btn" onClick={runCheck}>Check connection</button>
            {check && (
              <div className={`desc check-${check.state}`} style={{ marginTop: 9 }}>{check.message}</div>
            )}
          </Field>
        </>
      )}

      {tab === 'behaviour' && (
        <>
          <Field label="House instruction" hint="Prepended as a system message for every seat.">
            <input
              type="text"
              value={settings.systemPrompt}
              onChange={(e) => update({ systemPrompt: e.target.value })}
            />
          </Field>

          <Field
            label="Voice sample (optional)"
            hint="Paste a few sentences of your own writing. The humanizer matches its rhythm and word choice instead of defaulting to generic-natural."
          >
            <textarea
              rows={4}
              style={{ resize: 'vertical', lineHeight: 1.5 }}
              placeholder="Paste something you wrote…"
              value={settings.voiceSample}
              onChange={(e) => update({ voiceSample: e.target.value })}
            />
          </Field>

          <Field label="Conversation memory">
            <select
              value={settings.contextTurns}
              onChange={(e) => update({ contextTurns: Number(e.target.value) })}
            >
              <option value={0}>Each question stands alone</option>
              <option value={3}>Remember the last 3 turns</option>
              <option value={99}>Remember everything</option>
            </select>
          </Field>

          <Field label="Image search source">
            <select
              value={settings.imageSource}
              onChange={(e) => update({ imageSource: e.target.value })}
            >
              <option value="openverse">Openverse — keyless, CC-licensed</option>
              <option value="mesh">Mesh web search — $0.005 each</option>
            </select>
          </Field>
        </>
      )}

      {tab === 'about' && (
        <>
          <Field label="Four modes">
            <div className="desc">
              <b>Quick</b> — one small fast model, one streamed card.<br />
              <b>Council</b> — the Karpathy pipeline: parallel answers, anonymous peer review with
              scores, then a chairman synthesis. Roughly 3–6× the cost of a single query, which is
              the honest tradeoff for the accuracy.<br />
              <b>Study</b> — paste a topic and get a worked pack: orientation, concept map, layered
              explanation, misconceptions, flashcards, self-check quiz.<br />
              <b>Humanize</b> — paste AI-sounding text; it drafts, audits its own draft for what
              still reads machine-written, then rewrites. You see all three.
            </div>
          </Field>

          <Field label="Where your key lives">
            <div className="desc">
              On the server, in <code>.env</code>, never in the browser. The client talks only to
              this app's own API — it has no credentials and cannot reach the gateway directly.
              Settings sync through MongoDB and are scrubbed of anything key-shaped on arrival.
            </div>
          </Field>

          <Field label="Design notes">
            <div className="desc">
              macOS idiom: vibrancy over flat fills, hairline borders, SF system type, a sliding
              segmented control, spring easing on every transition. Jakob's Law for the chat
              conventions, Doherty for streaming with skeletons, Hick's for hiding configuration in
              a sheet, Von Restorff for the violet verdict card, Fitts for the control sizes.
              Everything collapses under <code>prefers-reduced-motion</code>.
            </div>
          </Field>
        </>
      )}
    </Sheet>
  );
});
