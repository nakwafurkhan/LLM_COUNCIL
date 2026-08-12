import mongoose from "mongoose";

/**
 * One turn in a conversation.
 *
 * Usage and cost are recorded per message rather than only per conversation,
 * so the UI can show the cost delta between an expensive chat turn and a cheap
 * quick one — the tradeoff is only meaningful if it is visible.
 */
const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
      required: true,
      index: true,
    },
    role: { type: String, enum: ["system", "user", "assistant"], required: true },
    content: { type: String, default: "" },
    model: { type: String, default: null },

    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    /** True when tokens were estimated because the provider omitted usage. */
    estimatedUsage: { type: Boolean, default: false },
    latencyMs: { type: Number, default: 0 },

    /**
     * Set when the client disconnected mid-stream. The partial text is kept —
     * throwing away tokens the user already watched arrive is worse than
     * storing them and saying so.
     */
    interrupted: { type: Boolean, default: false },

    /** Set when a turn is superseded by an edit or regenerate. */
    supersededAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The transcript read: every message for a conversation, in order.
messageSchema.index({ conversationId: 1, createdAt: 1 });

export const Message = mongoose.models.Message ?? mongoose.model("Message", messageSchema);
