import mongoose from 'mongoose';

const { Schema } = mongoose;

/* Sub-documents are declared with _id: false — these are value objects, not
   entities, and per-element ObjectIds would just bloat every document. */

const SeatSchema = new Schema({
  index: { type: Number, required: true },
  model: { type: String, required: true, trim: true },
  text: { type: String, default: '' },
  ms: { type: Number, default: 0 },
  firstTokenMs: { type: Number, default: 0 },
  error: { type: String, default: '' }
}, { _id: false });

const RankSchema = new Schema({
  index: { type: Number, required: true },
  model: { type: String, required: true },
  mean: { type: Number, default: 0 },
  votes: { type: Number, default: 0 },
  rank: { type: Number, default: 0 },
  critiques: { type: [String], default: [] }
}, { _id: false });

const CardSchema = new Schema({
  q: { type: String, required: true },
  a: { type: String, default: '' }
}, { _id: false });

/* Study packs and humanizer output are parsed on the server, so history replay
   is a pure render with no re-parsing and no duplicated logic in the client. */
const StudySchema = new Schema({
  orient: String,
  map: String,
  core: String,
  misconceptions: String,
  example: String,
  goDeeper: String,
  flashcards: { type: [CardSchema], default: [] },
  quiz: { type: [CardSchema], default: [] },
  raw: String
}, { _id: false });

const HumanizeSchema = new Schema({
  draft: String,
  tells: { type: [String], default: [] },
  final: String,
  changes: { type: [String], default: [] },
  raw: String
}, { _id: false });

const RunSchema = new Schema({
  mode: {
    type: String,
    required: true,
    enum: ['quick', 'council', 'study', 'humanize'],
    index: true
  },
  prompt: { type: String, required: true, maxlength: 40000 },
  title: { type: String, default: '', maxlength: 200 },
  imageUrl: { type: String, default: '' },
  models: { type: [String], default: [] },
  ms: { type: Number, default: 0 },
  status: { type: String, enum: ['complete', 'stopped', 'failed'], default: 'complete' },

  answer: { type: String, default: '' },          // quick
  seats: { type: [SeatSchema], default: undefined },   // council
  ranking: { type: [RankSchema], default: undefined },
  chair: {
    type: new Schema({ model: String, text: String }, { _id: false }),
    default: undefined
  },
  study: { type: StudySchema, default: undefined },
  humanize: { type: HumanizeSchema, default: undefined }
}, {
  timestamps: true,
  versionKey: false,
  toJSON: {
    virtuals: true,
    transform: (_doc, ret) => { ret.id = ret._id.toString(); delete ret._id; return ret; }
  }
});

/* Newest-first listing is the only read path that matters, plus a text index so
   ?q= search does not degrade into a collection scan as history grows. */
RunSchema.index({ createdAt: -1 });
RunSchema.index({ mode: 1, createdAt: -1 });
RunSchema.index({ title: 'text', prompt: 'text' });

/* The list view never needs answer bodies — they are the bulk of a document. */
RunSchema.statics.listSummaries = function listSummaries({ limit = 50, mode, q } = {}) {
  const filter = {};
  if (mode) filter.mode = mode;
  if (q) filter.$or = [
    { title: { $regex: q, $options: 'i' } },
    { prompt: { $regex: q, $options: 'i' } }
  ];
  return this.find(filter)
    .select('mode title prompt models ms status createdAt')
    .sort({ createdAt: -1 })
    .limit(Math.min(Number(limit) || 50, 200))
    .lean()
    .then(rows => rows.map(({ _id, ...r }) => ({ id: _id.toString(), ...r })));
};

RunSchema.pre('validate', function setTitle(next) {
  if (!this.title && this.prompt) {
    this.title = this.prompt.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  next();
});

export const Run = mongoose.model('Run', RunSchema);
