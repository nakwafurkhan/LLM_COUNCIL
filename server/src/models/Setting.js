import mongoose from 'mongoose';
import { scrubSecrets } from '../utils/scrub.js';

const { Schema } = mongoose;

/**
 * One document, always. `key` is pinned to 'singleton' so an upsert can never
 * race into a second row.
 */
const SettingSchema = new Schema({
  key: { type: String, default: 'singleton', unique: true, immutable: true },
  value: { type: Schema.Types.Mixed, default: {} }
}, {
  timestamps: true,
  versionKey: false,
  toJSON: { transform: (_d, ret) => ({ ...ret.value, updatedAt: ret.updatedAt }) }
});

SettingSchema.statics.read = function read() {
  return this.findOne({ key: 'singleton' }).lean()
    .then(doc => (doc ? { ...doc.value, updatedAt: doc.updatedAt } : {}));
};

SettingSchema.statics.write = function write(value) {
  return this.findOneAndUpdate(
    { key: 'singleton' },
    { $set: { value: scrubSecrets(value) } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean().then(doc => ({ ...doc.value, updatedAt: doc.updatedAt }));
};

export const Setting = mongoose.model('Setting', SettingSchema);
