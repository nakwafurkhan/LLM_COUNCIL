const KNOWN_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4-turbo",
  "gpt-3.5-turbo",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
  "gemini-1.5-pro",
  "gemini-1.5-flash",
];

export default function ModelPicker({ value, onChange, label, id, models }) {
  const options = models ?? KNOWN_MODELS;
  return (
    <div className="model-picker">
      <label htmlFor={id} className="model-picker-label">
        {label ?? "Model"}
      </label>
      <select
        id={id}
        className="model-picker-select"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={label ?? "Select model"}
      >
        <option value="">Default</option>
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  );
}
