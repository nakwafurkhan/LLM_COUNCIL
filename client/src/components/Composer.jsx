import { useState, useRef, useCallback } from "react";

export default function Composer({ onSubmit, disabled, placeholder }) {
  const [value, setValue] = useState("");
  const textareaRef = useRef(null);

  const handleSubmit = useCallback(
    (e) => {
      e.preventDefault();
      const trimmed = value.trim();
      if (!trimmed || disabled) return;
      onSubmit(trimmed);
      setValue("");
    },
    [value, disabled, onSubmit],
  );

  const handleKeyDown = useCallback(
    (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e);
      }
    },
    [handleSubmit],
  );

  return (
    <form className="composer" onSubmit={handleSubmit} aria-label="Message composer">
      <textarea
        ref={textareaRef}
        className="composer-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder ?? "Type a message… (Enter to send, Shift+Enter for newline)"}
        disabled={disabled}
        rows={3}
        aria-label="Message input"
        aria-disabled={disabled}
      />
      <button
        type="submit"
        className="composer-submit"
        disabled={disabled || !value.trim()}
        aria-label="Send message"
      >
        {disabled ? "Sending…" : "Send"}
      </button>
    </form>
  );
}
