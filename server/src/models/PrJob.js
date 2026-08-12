import mongoose from "mongoose";

import { PR_STATUSES } from "../../../shared/schemas.js";

/**
 * A Code+PR job.
 *
 * The job is the unit of durability: an HTTP request returns as soon as the
 * record exists, and every subsequent state change is written here. That is
 * what makes progress readable after a page refresh and recoverable after a
 * process restart.
 */
const fileChangeSchema = new mongoose.Schema(
  {
    path: { type: String, required: true },
    action: { type: String, enum: ["create", "modify", "delete"], required: true },
    before: { type: String, default: null },
    after: { type: String, default: null },
    diff: { type: String, default: "" },
  },
  { _id: false },
);

const verificationResultSchema = new mongoose.Schema(
  {
    ok: { type: Boolean, default: false },
    skipped: { type: Boolean, default: false },
    command: { type: String, default: null },
    exitCode: { type: Number, default: null },
    output: { type: String, default: "" },
    durationMs: { type: Number, default: 0 },
  },
  { _id: false },
);

const prJobSchema = new mongoose.Schema(
  {
    task: { type: String, required: true },
    targetPaths: [String],
    branch: { type: String, required: true },
    baseBranch: { type: String, required: true },
    model: { type: String, required: true },

    status: { type: String, enum: PR_STATUSES, default: "queued", index: true },

    plan: {
      summary: String,
      files: [{ path: String, action: String, reason: String, _id: false }],
      notes: String,
    },

    files: [fileChangeSchema],

    verification: {
      lint: { type: verificationResultSchema, default: () => ({}) },
      tests: { type: verificationResultSchema, default: () => ({}) },
      repairAttempts: { type: Number, default: 0 },
    },

    prUrl: { type: String, default: null },
    prNumber: { type: Number, default: null },
    commitSha: { type: String, default: null },
    error: { type: String, default: null },

    /**
     * Sparse unique: a repeated Idempotency-Key returns the existing job
     * rather than opening a second PR for the same work.
     */
    idempotencyKey: { type: String, default: null },

    timeline: [{ status: String, at: Date, note: String, _id: false }],
  },
  { timestamps: true },
);

prJobSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    sparse: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
  },
);

// Concurrency guard: one active job per branch.
prJobSchema.index({ branch: 1, status: 1 });

/** Append a timeline entry and move the job to a new state. */
prJobSchema.methods.transition = function transition(status, note) {
  this.status = status;
  this.timeline.push({ status, at: new Date(), note: note ?? null });
  return this.save();
};

export const PrJob = mongoose.models.PrJob ?? mongoose.model("PrJob", prJobSchema);

/** Statuses that mean the job still owns its branch and worktree. */
export const ACTIVE_STATUSES = [
  "queued",
  "planning",
  "generating",
  "verifying",
  "awaiting_approval",
  "pushing",
];
