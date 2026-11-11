// Builds the five memory setups with their real dependencies: the taxonomy
// for rule ids, and the datapitfalls engine for Debrief reviews.
import type { PitfallReport, Transcript } from '@datapitfalls/schemas';
import {
  cachedAnswers,
  debriefMemory,
  logAll,
  noMemory,
  pitfallMemory,
  type MemorySetup,
  type SetupName,
  type TranscriptReviewer,
} from './memory.js';

export interface SetupFactoryOptions {
  /** Model for Debrief reviews. Defaults to the engine's own default. */
  reviewModel?: string;
  maxReviewsPerMonth?: number;
  seed?: number;
  /** A reviewer to use in place of the engine (tests and dry runs pass a fake). */
  review?: TranscriptReviewer;
}

export interface Taxonomy {
  resolveRuleId(id: string): string | undefined;
  taxonomyVersion: string;
  defaultModel: string;
  review(transcript: Transcript, model: string): Promise<PitfallReport>;
}

/** Load the taxonomy and engine from the datapitfalls package (public exports only). */
export async function loadTaxonomy(): Promise<Taxonomy> {
  const core = await import('datapitfalls');
  return {
    resolveRuleId: core.resolveRuleId,
    taxonomyVersion: core.taxonomyVersion,
    defaultModel: core.DEFAULT_MODEL,
    review: async (transcript, model) =>
      (await core.detectPitfalls({ kind: 'transcript', transcript }, { model })) as PitfallReport,
  };
}

export function createSetupFactory(
  taxonomy: Taxonomy,
  options: SetupFactoryOptions = {}
): (name: SetupName) => MemorySetup {
  const reviewModel = options.reviewModel ?? taxonomy.defaultModel;
  const shared = {
    resolveRuleId: taxonomy.resolveRuleId,
    taxonomyVersion: taxonomy.taxonomyVersion,
  };
  return (name) => {
    switch (name) {
      case 'none':
        return noMemory();
      case 'log-all':
        return logAll();
      case 'cache':
        return cachedAnswers();
      case 'pitfall':
        return pitfallMemory(shared);
      case 'debrief':
        return debriefMemory({
          ...shared,
          reviewModel,
          review: options.review ?? ((t) => taxonomy.review(t, reviewModel)),
          maxReviewsPerMonth: options.maxReviewsPerMonth,
          seed: options.seed,
        });
      default:
        throw new Error(`Unknown setup "${String(name)}"`);
    }
  };
}
