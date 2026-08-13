import { useState, useCallback, useRef } from "react";
import { apiFetch } from "../api/client.js";
import { ssePost } from "../api/client.js";

export function useConversation(mode) {
  const [conversation, setConversation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [streamingText, setStreamingText] = useState("");
  const abortRef = useRef(null);

  const createConversation = useCallback(
    async (model) => {
      setError(null);
      const data = await apiFetch("/conversations", {
        method: "POST",
        body: { mode, ...(model ? { model } : {}) },
      });
      setConversation(data);
      setMessages([]);
      return data;
    },
    [mode],
  );

  const loadMessages = useCallback(async (convId) => {
    const data = await apiFetch(`/conversations/${convId}/messages`);
    setMessages(data.items ?? []);
  }, []);

  const sendMessage = useCallback(
    async (convId, content, model, stream = true) => {
      setLoading(true);
      setError(null);
      setStreamingText("");

      if (stream) {
        // Optimistically add user message
        const userMsg = {
          id: `temp-${Date.now()}`,
          role: "user",
          content,
          createdAt: new Date().toISOString(),
        };
        setMessages((prev) => [...prev, userMsg]);

        return new Promise((resolve, reject) => {
          let assistantContent = "";
          abortRef.current = ssePost(
            `/conversations/${convId}/messages`,
            { content, stream: true, ...(model ? { model } : {}) },
            {
              onEvent(event, data) {
                if (event === "delta") {
                  assistantContent += data.text ?? "";
                  setStreamingText(assistantContent);
                } else if (event === "message") {
                  const assistantMsg = {
                    id: data.messageId,
                    role: "assistant",
                    content: data.content,
                    model: data.model,
                    promptTokens: data.usage?.promptTokens,
                    completionTokens: data.usage?.completionTokens,
                    costUsd: data.usage?.costUsd,
                    latencyMs: data.latencyMs,
                    interrupted: data.interrupted,
                    createdAt: new Date().toISOString(),
                  };
                  setMessages((prev) => {
                    // Replace temp user message with confirmed + assistant
                    const withoutTemp = prev.filter((m) => !m.id.startsWith("temp-"));
                    return [...withoutTemp, userMsg, assistantMsg];
                  });
                  setStreamingText("");
                } else if (event === "done") {
                  setLoading(false);
                  resolve();
                } else if (event === "error") {
                  const err = new Error(data?.error?.message ?? "Stream error");
                  err.code = data?.error?.code;
                  setError(err);
                  setLoading(false);
                  reject(err);
                }
              },
              onError(err) {
                setError(err);
                setLoading(false);
                reject(err);
              },
              onDone() {
                setLoading(false);
                resolve();
              },
            },
          );
        });
      } else {
        try {
          const data = await apiFetch(`/conversations/${convId}/messages`, {
            method: "POST",
            body: { content, stream: false, ...(model ? { model } : {}) },
          });
          setConversation(data.conversation);
          await loadMessages(convId);
        } finally {
          setLoading(false);
        }
      }
    },
    [loadMessages],
  );

  const regenerate = useCallback(
    async (convId, model) => {
      setLoading(true);
      setError(null);
      try {
        const data = await apiFetch(`/conversations/${convId}/regenerate`, {
          method: "POST",
          body: model ? { model } : {},
        });
        setConversation(data.conversation);
        await loadMessages(convId);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [loadMessages],
  );

  const abort = useCallback(() => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
      setLoading(false);
    }
  }, []);

  return {
    conversation,
    messages,
    loading,
    error,
    streamingText,
    createConversation,
    loadMessages,
    sendMessage,
    regenerate,
    abort,
    setConversation,
    setMessages,
  };
}
