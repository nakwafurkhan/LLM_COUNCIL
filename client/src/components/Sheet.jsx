import { memo } from 'react';

/**
 * Side drawer on desktop, bottom sheet under 860px. Both behaviours are pure
 * CSS; this only owns the shell, the grabber and the close affordance.
 */
export const Sheet = memo(function Sheet({ open, title, onClose, children, footer }) {
  return (
    <aside className={`panel${open ? ' on' : ''}`} aria-hidden={!open}>
      <div className="grabber" />
      <div className="head">
        <h3>{title}</h3>
        <div className="spacer" />
        <button className="iconbtn" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="content">{children}</div>
      {footer}
    </aside>
  );
});

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      {label ? <label>{label}</label> : null}
      {hint ? <div className="desc">{hint}</div> : null}
      {children}
    </div>
  );
}

export function Switch({ checked, onChange, label }) {
  return (
    <button
      className="switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    />
  );
}
