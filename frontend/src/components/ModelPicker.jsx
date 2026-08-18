import React, { memo, useEffect, useMemo, useRef, useState } from 'react';

/**
 * One picker for every mode.
 *
 * `multi` switches between single-select (Chat / Quick / Humanizer) and
 * multi-select (Council). The list comes from the live Mesh catalogue, so it
 * cannot go stale as models are added or retired.
 */
function ModelPicker({ models, selected, onChange, multi = false, label = 'Model' }) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const ref = useRef(null);
  const inputRef = useRef(null);

  const chosen = useMemo(
    () => (Array.isArray(selected) ? selected : [selected].filter(Boolean)),
    [selected],
  );

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    inputRef.current?.focus();
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle
      ? models.filter((m) => m.id.toLowerCase().includes(needle))
      : models;
    return list.slice(0, 150);
  }, [models, filter]);

  const pick = (id) => {
    if (!multi) {
      onChange(id);
      setOpen(false);
      return;
    }
    onChange(
      chosen.includes(id) ? chosen.filter((item) => item !== id) : [...chosen, id],
    );
  };

  const summary = multi
    ? `${chosen.length} model${chosen.length === 1 ? '' : 's'}`
    : chosen[0] || 'choose a model';

  return (
    <div className="picker" ref={ref}>
      <button
        type="button"
        className="picker-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={multi ? chosen.join(', ') : summary}
      >
        {label}: {summary}
      </button>

      {open ? (
        <div className="pop" role="listbox">
          <input
            ref={inputRef}
            className="mini"
            placeholder="Filter models…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="pop-list">
            {visible.map((model) => (
              <button
                type="button"
                key={model.id}
                className="pop-row"
                role="option"
                aria-selected={chosen.includes(model.id)}
                onClick={() => pick(model.id)}
              >
                <span aria-hidden="true">{chosen.includes(model.id) ? '✓' : ' '}</span>
                <span>{model.id}</span>
                {model.context_length ? (
                  <span className="ctx">{Math.round(model.context_length / 1000)}k</span>
                ) : null}
              </button>
            ))}
            {!visible.length ? (
              <p className="dim" style={{ padding: '10px 8px', margin: 0 }}>
                No models match “{filter}”.
              </p>
            ) : null}
          </div>
          <div className="pop-foot">
            <span>{models.length} available</span>
            {multi ? <span className="dim">· pick 2–4 for a useful council</span> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default memo(ModelPicker);
