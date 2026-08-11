import { memo } from 'react';
import { MODES } from '../lib/modes.js';

export const Hero = memo(function Hero({ mode, onPick }) {
  const config = MODES[mode];
  return (
    /* key remounts the section on mode change, replaying the entrance animation */
    <section className="hero" key={mode}>
      <span className="badge"><i />{config.badge}</span>
      <h2>
        {config.title[0]}
        <em>{config.title[1]}</em>
      </h2>
      <p>{config.sub}</p>
      <div className="suggests">
        {config.suggestions.map(([label, prompt]) => (
          <button className="sug" key={label} onClick={() => onPick(prompt)}>
            <b>{label}</b>
            {prompt.length > 150 ? `${prompt.slice(0, 150)}…` : prompt}
          </button>
        ))}
      </div>
    </section>
  );
});
