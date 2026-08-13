import mongoose from "mongoose";

import { TONES } from "../../../shared/schemas.js";

/**
 * One humanizer run: original text, the three passes, and the pattern counts
 * before and after.
 *
 * All three passes are stored, not just the final text. The audit is the part
 * that explains *why* the final differs from the draft, and discarding it
 * would leave a rewrite nobody can evaluate.
 */
const findingSchema = new mongoose.Schema(
  {
    id: String,
    label: String,
    count: Number,
    severity: { type: String, enum: ["high", "medium", "low"] },
    note: String,
    examples: [String],
  },
  { _id: false },
);

const analysisSchema = new mongoose.Schema(
  {
    total: { type: Number, default: 0 },
    wordCount: { type: Number, default: 0 },
    per1000Words: { type: Number, default: 0 },
    findings: [findingSchema],
  },
  { _id: false },
);

const humanizerRunSchema = new mongoose.Schema(
  {
    original: { type: String, required: true },
    draft: { type: String, default: "" },
    /** What the model found still wrong with its own draft. */
    audit: {
      notes: { type: [String], default: [] },
      raw: { type: String, default: "" },
    },
    final: { type: String, default: "" },

    before: { type: analysisSchema, default: () => ({}) },
    after: { type: analysisSchema, default: () => ({}) },

    tone: { type: String, enum: TONES, default: "neutral" },
    /** Whether a writing sample was supplied. The sample itself is not stored. */
    voiceSampleUsed: { type: Boolean, default: false },

    model: { type: String, required: true },
    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    latencyMs: { type: Number, default: 0 },

    /** Set when a pass produced nothing usable and the run degraded. */
    partial: { type: Boolean, default: false },
    partialReason: { type: String, default: null },
  },
  { timestamps: true },
);

humanizerRunSchema.index({ createdAt: -1 });

export const HumanizerRun =
  mongoose.models.HumanizerRun ?? mongoose.model("HumanizerRun", humanizerRunSchema);
