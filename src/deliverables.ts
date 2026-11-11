// Exploration: tasks that ask for a deliverable (a chart and a short written
// takeaway) instead of a single number, reviewed against the taxonomy by the
// datapitfalls engine. This is not part of the scored benchmark yet; it exists
// to find out which judgment and design pitfalls an agent actually commits.
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import type { PitfallReport } from '@datapitfalls/schemas';
import yaml from 'js-yaml';
import { SCHEMA_BRIEFING } from './agent.js';
import { addUsage, NO_USAGE, type Usage } from './pricing.js';
import type { SqlTool } from './sql-tool.js';

export interface Brief {
  id: string;
  audience: string;
  text: string;
  /** What a careful answer would notice. For the reader of results; never shown to the agent. */
  watch: string;
}

export function loadBriefs(path: string): Brief[] {
  const raw = yaml.load(readFileSync(path, 'utf8')) as { briefs?: Brief[] } | null;
  if (!raw || !Array.isArray(raw.briefs) || !raw.briefs.length) {
    throw new Error(`${path}: expected a "briefs" list`);
  }
  const seen = new Set<string>();
  for (const b of raw.briefs) {
    if (!b.id || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(b.id)) throw new Error(`${path}: bad brief id`);
    if (seen.has(b.id)) throw new Error(`${path}: duplicate brief "${b.id}"`);
    seen.add(b.id);
    if (!b.text || !b.audience || !b.watch) {
      throw new Error(`${path}: brief "${b.id}" needs text, audience and watch`);
    }
  }
  return raw.briefs;
}

export interface Deliverable {
  briefId: string;
  /** PNG bytes of the submitted chart, or null when none was produced. */
  chart: Buffer | null;
  chartFile: string;
  title: string;
  takeaway: string;
  /** Every query the agent ran, in order. */
  queries: string[];
  /** The Python the agent ran in the sandbox, in order. */
  code: string[];
  usage: Usage;
  steps: number;
  error?: string;
}

export const DELIVERABLE_SYSTEM = [
  'You are a data analyst. A colleague has asked you for a chart and a short written takeaway.',
  SCHEMA_BRIEFING,
  'How to work: use run_sql to query the data (one SELECT per call; results show at most 200 rows). The data ends at the month named in the request; later months do not exist yet. Then use the code execution tool to draw the chart with Python and matplotlib, typing the query results into your code, and save it as a PNG copied to $OUTPUT_DIR. Finish by calling submit_deliverable once with the chart file name, a title and the takeaway: two or three sentences written for the audience named in the request.',
].join('\n\n');

const RUN_SQL: Anthropic.Tool = {
  name: 'run_sql',
  description: 'Run one read-only SQLite SELECT against the database; rows come back as CSV.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: { sql: { type: 'string' } },
    required: ['sql'],
    additionalProperties: false,
  },
};

const SUBMIT: Anthropic.Tool = {
  name: 'submit_deliverable',
  description: 'Submit the finished chart and takeaway. Call this exactly once, at the end.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      chart_file: { type: 'string', description: 'File name of the PNG saved to $OUTPUT_DIR.' },
      title: { type: 'string' },
      takeaway: { type: 'string', description: 'Two or three sentences for the audience.' },
    },
    required: ['chart_file', 'title', 'takeaway'],
    additionalProperties: false,
  },
};

const CODE_EXECUTION = { type: 'code_execution_20260521', name: 'code_execution' } as const;

/** The parts of the SDK client this module uses, so tests can pass a fake. */
export interface DeliverableClient {
  messages: Pick<Anthropic['messages'], 'create'>;
  files: {
    retrieveMetadata(id: string): Promise<{ filename: string }>;
    download(id: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
  };
}

export interface DeliverableOptions {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxSteps?: number;
}

function usageOf(u: Anthropic.Usage): Usage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** Ask the agent for one deliverable. API errors are thrown to the caller. */
export async function produceDeliverable(
  client: DeliverableClient,
  brief: Brief,
  asOf: string,
  runSql: SqlTool,
  options: DeliverableOptions
): Promise<Deliverable> {
  const out: Deliverable = {
    briefId: brief.id,
    chart: null,
    chartFile: '',
    title: '',
    takeaway: '',
    queries: [],
    code: [],
    usage: NO_USAGE,
    steps: 0,
  };
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `The newest month in the data is ${asOf}.\nAudience: ${brief.audience}.\nRequest: ${brief.text}`,
    },
  ];
  // File ids of everything the sandbox wrote, newest last, by file name.
  const files = new Map<string, string>();
  let container: string | undefined;
  let nudged = false;
  const maxSteps = options.maxSteps ?? 14;

  while (out.steps < maxSteps) {
    const response = await client.messages.create({
      model: options.model,
      max_tokens: 16000,
      output_config: { effort: options.effort },
      system: [{ type: 'text', text: DELIVERABLE_SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [RUN_SQL, CODE_EXECUTION, SUBMIT],
      messages,
      ...(container ? { container } : {}),
    });
    out.steps += 1;
    out.usage = addUsage(out.usage, usageOf(response.usage));
    container = response.container?.id ?? container;
    messages.push({ role: 'assistant', content: response.content });

    for (const block of response.content) {
      if (block.type === 'server_tool_use') {
        const input = block.input as { command?: string; file_text?: string };
        const text = input.command ?? input.file_text;
        if (text) out.code.push(text);
      }
      if (block.type === 'bash_code_execution_tool_result') {
        const result = block.content;
        if (result.type === 'bash_code_execution_result') {
          for (const ref of result.content) {
            const meta = await client.files.retrieveMetadata(ref.file_id);
            files.set(meta.filename, ref.file_id);
          }
        }
      }
    }

    if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') {
      out.error = response.stop_reason;
      break;
    }
    // A long sandbox turn can pause; sending the conversation back resumes it.
    if (response.stop_reason === 'pause_turn') continue;

    const calls = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );
    if (!calls.length) {
      if (nudged) {
        out.error = 'no_deliverable';
        break;
      }
      nudged = true;
      messages.push({ role: 'user', content: 'Call submit_deliverable now.' });
      continue;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    let submitted = false;
    for (const call of calls) {
      const input = call.input as Record<string, unknown>;
      if (call.name === 'run_sql') {
        const sql = String(input.sql ?? '');
        out.queries.push(sql);
        const r = await runSql(sql);
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: r.text,
          is_error: !r.ok,
        });
      } else if (call.name === 'submit_deliverable') {
        out.chartFile = String(input.chart_file ?? '').replace(/^.*\//, '');
        out.title = String(input.title ?? '');
        out.takeaway = String(input.takeaway ?? '');
        submitted = true;
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Received.' });
      } else {
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: `Unknown tool ${call.name}`,
          is_error: true,
        });
      }
    }
    if (submitted) break;
    messages.push({ role: 'user', content: results });
  }

  if (!out.takeaway && !out.error) out.error = 'step_limit';
  // The named file if the sandbox returned it; otherwise the last PNG it wrote.
  const pngs = [...files.keys()].filter((name) => name.toLowerCase().endsWith('.png'));
  const chosen = files.has(out.chartFile) ? out.chartFile : pngs[pngs.length - 1];
  if (chosen) {
    const body = await client.files.download(files.get(chosen) as string);
    out.chart = Buffer.from(await body.arrayBuffer());
    out.chartFile = chosen;
  } else if (!out.error) {
    out.error = 'no_chart';
  }
  return out;
}

/** The engine input for one deliverable: its queries, plotting code, chart and takeaway, as one chain. */
export function reviewInput(brief: Brief, d: Deliverable): unknown {
  const stages: { role: string; artifact: unknown }[] = [];
  if (d.queries.length) {
    stages.push({
      role: 'Data queries (SQL)',
      artifact: { kind: 'code', language: 'SQL', content: d.queries.join(';\n\n') },
    });
  }
  if (d.code.length) {
    stages.push({
      role: 'Chart code (Python)',
      artifact: { kind: 'code', language: 'Python', content: d.code.join('\n\n# ---\n\n') },
    });
  }
  if (d.chart) {
    stages.push({
      role: 'Chart',
      artifact: {
        kind: 'image',
        images: [{ content: d.chart.toString('base64'), mediaType: 'image/png' }],
      },
    });
  }
  stages.push({
    role: 'Request and written takeaway',
    artifact: {
      kind: 'text',
      content: `Request from ${brief.audience}: ${brief.text}\n\nChart title: ${d.title}\n\nTakeaway: ${d.takeaway}`,
    },
  });
  return { kind: 'chain', stages };
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface GalleryEntry {
  brief: Brief;
  deliverable: Deliverable;
  report: PitfallReport | null;
  reviewError?: string;
}

/** One self-contained HTML page: each brief with its chart, takeaway and the review's findings. */
export function renderGallery(
  entries: GalleryEntry[],
  meta: { model: string; asOf: string; reviewModel: string }
): string {
  const cards = entries.map(({ brief, deliverable: d, report, reviewError }) => {
    const img = d.chart
      ? `<img alt="${esc(d.title)}" src="data:image/png;base64,${d.chart.toString('base64')}">`
      : `<p class="none">No chart was produced (${esc(d.error ?? 'unknown')}).</p>`;
    const findings = report
      ? report.findings.length
        ? `<ul>${report.findings
            .map(
              (f) =>
                `<li><strong>${esc(f.name)}</strong> <code>${esc(f.ruleId)}</code> <span class="tag">${esc(f.severity)} · ${esc(f.nature)} · ${esc(f.confidence)} confidence</span><br>${esc(f.explanation)}<br><em>${esc(f.evidence)}</em></li>`
            )
            .join('')}</ul>`
        : '<p class="none">The review found no pitfalls.</p>'
      : `<p class="none">Not reviewed (${esc(reviewError ?? 'no review')}).</p>`;
    return `<section>
<h2>${esc(brief.id)}</h2>
<p class="brief"><strong>Request (${esc(brief.audience)}):</strong> ${esc(brief.text)}</p>
${img}
<p><strong>${esc(d.title)}</strong></p>
<p>${esc(d.takeaway)}</p>
<h3>What a careful answer would notice</h3>
<p class="watch">${esc(brief.watch)}</p>
<h3>Review findings</h3>
${findings}
<details><summary>Queries and chart code</summary><pre>${esc(d.queries.join(';\n\n'))}</pre><pre>${esc(d.code.join('\n\n# ---\n\n'))}</pre></details>
</section>`;
  });
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>datapitfalls bench: deliverables exploration</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:920px;margin:2rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}
section{border-top:1px solid #ccc;padding:1.5rem 0}
img{max-width:100%;border:1px solid #ddd}
h2{font-size:1.2rem;margin:0 0 .5rem}h3{font-size:1rem;margin:1.2rem 0 .3rem}
code{background:#f0f0f0;padding:0 .3em}.tag{color:#555;font-size:.85rem}
.watch{background:#f6f3e8;padding:.6rem .8rem}.none{color:#555}
pre{white-space:pre-wrap;background:#f6f6f6;padding:.6rem;font-size:.8rem;overflow-x:auto}
li{margin-bottom:.8rem}
</style></head><body>
<h1>Deliverables exploration</h1>
<p>Agent: ${esc(meta.model)}, no memory, data as of ${esc(meta.asOf)}. Each chart and takeaway was reviewed by the datapitfalls engine on ${esc(meta.reviewModel)}. The findings are the engine's and have not been checked by a person.</p>
${cards.join('\n')}
</body></html>
`;
}
