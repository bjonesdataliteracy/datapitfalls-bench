// The `deliver` command: run the deliverables exploration end to end.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import {
  loadBriefs,
  produceDeliverable,
  renderGallery,
  reviewInput,
  type GalleryEntry,
} from './deliverables.js';
import { costUsd, PRICES } from './pricing.js';
import { materializeAsOf } from './replay.js';
import { benchApiKey, loadTaxonomy } from './setup-factory.js';
import { createSqlTool } from './sql-tool.js';

export interface DeliverConfig {
  db: string;
  asOf: string;
  outDir: string;
  budgetUsd: number;
  briefsFile: string;
  model: string;
  reviewModel: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  only?: string[];
  review: boolean;
}

export async function runDeliver(config: DeliverConfig): Promise<number> {
  if (!(config.budgetUsd > 0)) throw new Error('A budget above zero is required.');
  if (!PRICES[config.model] || !PRICES[config.reviewModel]) {
    throw new Error('No price is recorded for that model (src/pricing.ts).');
  }
  const briefs = loadBriefs(config.briefsFile).filter(
    (b) => !config.only || config.only.includes(b.id)
  );
  mkdirSync(config.outDir, { recursive: true });
  const asOfPath = join(config.outDir, `asof-${config.asOf}.db`);
  if (!existsSync(asOfPath)) materializeAsOf(config.db, config.asOf, asOfPath);
  const runSql = createSqlTool(asOfPath, { maxRows: 200, maxChars: 16000 });
  const apiKey = benchApiKey();
  const client = new Anthropic({ maxRetries: 4, ...(apiKey ? { apiKey } : {}) });
  const taxonomy = await loadTaxonomy();
  console.log(
    `This run calls the Claude API (${config.model}, effort ${config.effort}; reviews on ` +
      `${config.reviewModel}) and stops once estimated spend reaches $${config.budgetUsd.toFixed(2)}. ` +
      'Sandbox time for chart code is billed separately and is not counted here.'
  );

  let spent = 0;
  const entries: GalleryEntry[] = [];
  for (const brief of briefs) {
    if (spent >= config.budgetUsd) {
      console.log('STOPPED EARLY: the budget was reached.');
      break;
    }
    const deliverable = await produceDeliverable(client, brief, config.asOf, runSql, {
      model: config.model,
      effort: config.effort,
    });
    spent += costUsd(config.model, deliverable.usage);
    if (deliverable.chart) writeFileSync(join(config.outDir, `${brief.id}.png`), deliverable.chart);
    const entry: GalleryEntry = { brief, deliverable, report: null };
    if (config.review && deliverable.takeaway) {
      try {
        entry.report = await taxonomy.reviewAny(
          reviewInput(brief, deliverable),
          config.reviewModel
        );
        const u = entry.report.usage;
        spent += costUsd(config.reviewModel, {
          inputTokens: u?.inputTokens ?? 0,
          outputTokens: u?.outputTokens ?? 0,
          cacheReadTokens: u?.cacheReadInputTokens ?? 0,
          cacheWriteTokens: u?.cacheCreationInputTokens ?? 0,
        });
      } catch (error) {
        entry.reviewError = error instanceof Error ? error.message : String(error);
      }
    }
    entries.push(entry);
    const reviewed = entry.report
      ? `${entry.report.findings.length} findings`
      : `not reviewed${entry.reviewError ? ` (${entry.reviewError})` : ''}`;
    console.log(
      `${brief.id}: ${deliverable.error ?? 'ok'}, ${deliverable.steps} requests, ${reviewed}, ` +
        `spent so far $${spent.toFixed(2)}`
    );
    // Written after every brief, so a stopped run still leaves its results.
    writeFileSync(
      join(config.outDir, 'results.json'),
      JSON.stringify(
        entries.map((e) => ({
          brief: e.brief,
          deliverable: {
            ...e.deliverable,
            chart: e.deliverable.chart ? `${e.brief.id}.png` : null,
          },
          report: e.report,
          reviewError: e.reviewError,
        })),
        null,
        2
      )
    );
    writeFileSync(
      join(config.outDir, 'gallery.html'),
      renderGallery(entries, {
        model: config.model,
        asOf: config.asOf,
        reviewModel: config.reviewModel,
      })
    );
  }
  console.log(
    `\n${entries.length} deliverables -> ${join(config.outDir, 'gallery.html')}, ` +
      `estimated spend $${spent.toFixed(2)}`
  );
  return 0;
}
