import { useEffect, useCallback, useState } from "react";
import { useConversation } from "../hooks/useConversation.js";
import { apiFetch } from "../api/client.js";
import MessageList from "../components/MessageList.jsx";
import Composer from "../components/Composer.jsx";
import ModelPicker from "../components/ModelPicker.jsx";

/** Most recent non-archived conversation for a mode, or null. */
async function resumeLatest(mode) {
  const { items } = await apiFetch(`/conversations?mode=${mode}&limit=1`);
  return items?.[0] ?? null;
}

async function loadMessages(conversationId) {
  const { items } = await apiFetch(`/conversations/${conversationId}/messages`);
  return items ?? [];
}

export default function ChatRoute({ mode }) {
  const {
    conversation,
    messages,
    loading,
    error,
    streamingText,
    createConversation,
    sendMessage,
    regenerate,
    setConversation,
    setMessages,
  } = useConversation(mode);

  const [model, setModel] = useState(null);
  const [initError, setInitError] = useState(null);
  const [retrying, setRetrying] = useState(false);

  const init = useCallback(async () => {
    setInitError(null);
    try {
      // Resume the most recent conversation for this mode rather than always
      // starting a new one. History lives on the server now, so a reload that
      // silently abandoned it would waste the whole point of persisting it.
      const existing = await resumeLatest(mode);
      if (existing) {
        setConversation(existing);
        setMessages(await loadMessages(existing.id));
        return;
      }
      await createConversation(model);
    } catch (err) {
      setInitError(err);
    }
    // Intentionally omitting model so init only reacts to mode changes
  }, [createConversation, mode, setConversation, setMessages]);

  useEffect(() => {
    setConversation(null);
    setMessages([]);
    init();
  }, [mode]);

  const handleSubmit = useCallback(
    async (content) => {
      if (!conversation) return;
      try {
        await sendMessage(conversation.id, content, model, true);
      } catch {
        // error shown via error state
      }
    },
    [conversation, sendMessage, model],
  );

  const handleRegenerate = useCallback(async () => {
    if (!conversation) return;
    setRetrying(true);
    try {
      await regenerate(conversation.id, model);
    } finally {
      setRetrying(false);
    }
  }, [conversation, regenerate, model]);

  const handleRetry = useCallback(() => {
    init();
  }, [init]);

  const modeLabel = mode === "quick" ? "Quick (single-turn)" : "Chat (multi-turn)";

  return (
    <div className="chat-route">
      <div className="chat-header">
        <h1 className="chat-title">{modeLabel}</h1>
        <div className="chat-controls">
          <ModelPicker id="chat-model" label="Model" value={model} onChange={setModel} />
          {messages.length > 0 && (
            <button
              className="btn btn--secondary"
              onClick={handleRegenerate}
              disabled={loading || retrying}
              aria-label="Regenerate last response"
            >
              Regenerate
            </button>
          )}
        </div>
      </div>

      {initError && (
        <div className="error-banner" role="alert">
          <p>Failed to start conversation: {initError.message}</p>
          <button className="btn btn--retry" onClick={handleRetry}>
            Retry
          </button>
        </div>
      )}

      {error && (
        <div className="error-banner" role="alert">
          <p>Error: {error.message}</p>
        </div>
      )}

      <MessageList messages={messages} streamingText={streamingText} />

      <Composer
        onSubmit={handleSubmit}
        disabled={loading || !conversation}
        placeholder={
          mode === "quick"
            ? "Ask a quick question… (new conversation each time)"
            : "Type a message…"
        }
      />
    </div>
  );
}
