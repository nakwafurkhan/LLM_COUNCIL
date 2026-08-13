import { useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

function renderSafeMarkdown(content) {
  return DOMPurify.sanitize(marked.parse(content ?? ""), {
    FORBID_TAGS: ["script", "style"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
  });
}

/**
 * PassPanel — displays one pass of the humanizer (draft / audit / final).
 *
 * Props:
 *   heading      — string, e.g. "Pass 1 — Draft"
 *   text         — streaming or complete text (rendered as safe markdown)
 *   notes        — string[] (audit pass only — the list of remaining AI tells)
 *   streaming    — bool, true while tokens are still arriving
 *   defaultOpen  — bool, whether to start expanded (default: true)
 *   prominent    — bool, adds extra visual emphasis (used for the audit pass)
 */
export default function PassPanel({
  heading,
  text,
  notes,
  streaming = false,
  defaultOpen = true,
  prominent = false,
}) {
  const [open, setOpen] = useState(defaultOpen);

  const isEmpty = !text && (!notes || notes.length === 0);
  if (isEmpty && !streaming) return null;

  return (
    <section
      className={`pass-panel${prominent ? " pass-panel--prominent" : ""}`}
      aria-label={heading}
    >
      <button
        type="button"
        className="pass-panel-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="pass-panel-heading">{heading}</span>
        {streaming && (
          <span className="pass-panel-streaming-badge" aria-label="Streaming">
            …
          </span>
        )}
        <span className="pass-panel-chevron" aria-hidden="true">
          {open ? "▲" : "▼"}
        </span>
      </button>

      {open && (
        <div className="pass-panel-body">
          {text && (
            <div
              aria-live="polite"
              aria-atomic="false"
              className="pass-panel-text"
              dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(text) }}
            />
          )}

          {notes && notes.length > 0 && (
            <div className="pass-panel-notes">
              <h4 className="pass-panel-notes-heading">
                Remaining AI tells spotted by the model
              </h4>
              <ul className="pass-panel-notes-list" aria-label="Audit notes">
                {notes.map((note, i) => (
                  <li key={i} className="pass-panel-note">
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {notes && notes.length === 0 && !text && (
            <p className="pass-panel-empty">No remaining tells flagged.</p>
          )}
        </div>
      )}
    </section>
  );
}
