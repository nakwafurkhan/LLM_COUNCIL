import mongoose from "mongoose";

/**
 * A conversation in either chat or quick mode.
 *
 * Server-side history is what replaces the old pattern of the browser posting
 * its entire `messages` array on every turn — that made history trivially
 * forgeable, unbounded, and lost on refresh.
 */
const conversationSchema = new mongoose.Schema(
  {
    mode: { type: String, enum: ["chat", "quick"], required: true, index: true },
    title: { type: String, default: "New conversation", maxlength: 200 },
    model: { type: String, required: true },

    /**
     * Rolling summary of turns that have aged out of the verbatim window.
     * Lets a long thread stay coherent without resending the whole transcript
     * (and paying for it) on every request.
     */
    summary: { type: String, default: "" },
    summarizedUpTo: { type: Date, default: null },

    messageCount: { type: Number, default: 0 },
    totalCostUsd: { type: Number, default: 0 },

    archivedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// The list view: newest first, archived excluded.
conversationSchema.index({ archivedAt: 1, updatedAt: -1 });

/** Derive a title from the first user message. */
conversationSchema.statics.deriveTitle = function deriveTitle(text) {
  const cleaned = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "New conversation";
  return cleaned.length <= 60 ? cleaned : `${cleaned.slice(0, 57)}…`;
};

export const Conversation =
  mongoose.models.Conversation ?? mongoose.model("Conversation", conversationSchema);
