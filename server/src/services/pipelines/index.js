import { runQuick } from './quick.js';
import { runCouncil } from './council.js';
import { runStudy } from './study.js';
import { runHumanize } from './humanize.js';

export const pipelines = {
  quick: runQuick,
  council: runCouncil,
  study: runStudy,
  humanize: runHumanize
};

export const MODES = Object.keys(pipelines);
