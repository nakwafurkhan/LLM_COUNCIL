import { useState, useCallback } from "react";
import { useCouncilRun } from "../hooks/useCouncilRun.js";
import CouncilCard from "../components/CouncilCard.jsx";
import ChairmanPanel from "../components/ChairmanPanel.jsx";
import Composer from "../components/Composer.jsx";
import ModelPicker from "../components/ModelPicker.jsx";

export default function CouncilRoute() {
  const {
    run,
    models,
    chairmanModel,
    memberAnswers,
    chairmanText,
    status,
    error,
    submitPrompt,
    abort,
    reset,
  } = useCouncilRun();

  const [chairmanModelPick, setChairmanModelPick] = useState(null);
  const isStreaming = status === "streaming";

  const handleSubmit = useCallback(
    (prompt) => {
      submitPrompt(prompt, {
        stream: true,
        ...(chairmanModelPick ? { chairmanModel: chairmanModelPick } : {}),
      });
    },
    [submitPrompt, chairmanModelPick],
  );

  // Build card list: for models announced in `start` event, show skeleton until answer arrives
  const cardModels = models.length > 0 ? models : memberAnswers.map((a) => a.model);
  const answersByModel = Object.fromEntries(memberAnswers.map((a) => [a.model, a]));

  return (
    <div className="council-route">
      <div className="council-header">
        <h1 className="council-title">Council</h1>
        <div className="council-controls">
          <ModelPicker
            id="chairman-model"
            label="Chairman model"
            value={chairmanModelPick}
            onChange={setChairmanModelPick}
          />
          {isStreaming && (
            <button className="btn btn--secondary" onClick={abort} aria-label="Stop generation">
              Stop
            </button>
          )}
          {(status === "done" || status === "error") && (
            <button className="btn btn--secondary" onClick={reset} aria-label="New council run">
              New run
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <p>Error: {error.message}</p>
          <button className="btn btn--retry" onClick={reset}>
            Try again
          </button>
        </div>
      )}

      {cardModels.length > 0 && (
        <div className="council-cards" aria-label="Member responses">
          {cardModels.map((m) => (
            <CouncilCard
              key={m}
              answer={answersByModel[m] ?? null}
              loading={!answersByModel[m] && isStreaming}
            />
          ))}
        </div>
      )}

      {(chairmanText || run?.finalAnswer) && (
        <ChairmanPanel run={run} streamingText={chairmanText} chairmanModel={chairmanModel} />
      )}

      <Composer
        onSubmit={handleSubmit}
        disabled={isStreaming}
        placeholder="Ask the council a question…"
      />
    </div>
  );
}
