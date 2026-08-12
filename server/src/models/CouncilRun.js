import mongoose from "mongoose";

/**
 * One council run: the fan-out to member models plus the chairman synthesis.
 *
 * Members that failed are recorded rather than dropped. A run where two of
 * three models answered is a materially different artifact from one where all
 * three did, and the UI needs to be able to say so.
 */
const memberAnswerSchema = new mongoose.Schema(
  {
    model: { type: String, required: true },
    status: {
      type: String,
      enum: ["fulfilled", "rejected", "timeout"],
      required: true,
    },
    content: { type: String, default: "" },
    error: { type: String, default: null },
    latencyMs: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
  },
  { _id: false },
);

const disagreementSchema = new mongoose.Schema(
  {
    claim: { type: String, required: true },
    positions: [{ model: String, stance: String, _id: false }],
  },
  { _id: false },
);

const councilRunSchema = new mongoose.Schema(
  {
    prompt: { type: String, required: true },
    /** sha256 of normalised prompt + member set + chairman. Drives the cache. */
    promptHash: { type: String, required: true, index: true },

    models: [String],
    memberAnswers: [memberAnswerSchema],

    chairmanModel: { type: String, required: true },
    finalAnswer: { type: String, default: "" },
    disagreements: [disagreementSchema],
    confidence: { type: String, enum: ["low", "medium", "high"], default: "medium" },
    confidenceNote: { type: String, default: "" },

    /** True when at least one member failed but the run still produced an answer. */
    partial: { type: Boolean, default: false },
    partialReason: { type: String, default: null },

    totalPromptTokens: { type: Number, default: 0 },
    totalCompletionTokens: { type: Number, default: 0 },
    totalCostUsd: { type: Number, default: 0 },
    totalLatencyMs: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Cache lookup: most recent run for a hash.
councilRunSchema.index({ promptHash: 1, createdAt: -1 });

export const CouncilRun =
  mongoose.models.CouncilRun ?? mongoose.model("CouncilRun", councilRunSchema);
