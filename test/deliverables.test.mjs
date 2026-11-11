// Offline tests for the deliverables exploration. Nothing here calls an API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBriefs, produceDeliverable, renderGallery, reviewInput } from '../dist/index.js';

const briefs = loadBriefs(new URL('../briefs/briefs.yaml', import.meta.url).pathname);
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const png = Buffer.from('89504e470d0a1a0a', 'hex');

function fakeClient(replies) {
  const requests = [];
  return {
    requests,
    messages: {
      create: async (params) => {
        requests.push(structuredClone(params));
        return replies.shift();
      },
    },
    files: {
      retrieveMetadata: async (id) => ({ filename: id === 'f-old' ? 'draft.png' : 'chart.png' }),
      download: async () => ({
        arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.length),
      }),
    },
  };
}
const sandbox = (fileId) => [
  {
    type: 'server_tool_use',
    id: 's1',
    name: 'bash_code_execution',
    input: { command: 'python3 plot.py' },
  },
  {
    type: 'bash_code_execution_tool_result',
    tool_use_id: 's1',
    content: {
      type: 'bash_code_execution_result',
      stdout: '',
      stderr: '',
      return_code: 0,
      content: [{ type: 'bash_code_execution_output', file_id: fileId }],
    },
  },
];

test('the brief file loads: a dozen briefs, each with an audience and a watch note', () => {
  assert.equal(briefs.length, 12);
  assert.equal(new Set(briefs.map((b) => b.id)).size, 12);
  for (const b of briefs) assert.ok(b.text && b.audience && b.watch, b.id);
});

test('a deliverable session queries, draws in the sandbox, and returns the chart and takeaway', async () => {
  const client = fakeClient([
    {
      content: [{ type: 'tool_use', id: 't1', name: 'run_sql', input: { sql: 'SELECT 1 AS x' } }],
      stop_reason: 'tool_use',
      usage,
      container: { id: 'c1' },
    },
    { content: sandbox('f-old'), stop_reason: 'pause_turn', usage, container: { id: 'c1' } },
    {
      content: [
        ...sandbox('f-new'),
        {
          type: 'tool_use',
          id: 't2',
          name: 'submit_deliverable',
          input: { chart_file: '/tmp/out/chart.png', title: 'A title', takeaway: 'Two sentences.' },
        },
      ],
      stop_reason: 'tool_use',
      usage,
      container: { id: 'c1' },
    },
  ]);
  const queries = [];
  const runSql = async (sql) => {
    queries.push(sql);
    return { ok: true, text: 'x\n1' };
  };
  const d = await produceDeliverable(client, briefs[0], '2026-07', runSql, {
    model: 'claude-opus-5-5',
    effort: 'medium',
  });
  assert.equal(d.error, undefined);
  assert.equal(d.title, 'A title');
  assert.equal(d.takeaway, 'Two sentences.');
  assert.equal(d.chartFile, 'chart.png');
  assert.ok(d.chart.equals(png));
  assert.deepEqual(d.queries, ['SELECT 1 AS x']);
  assert.deepEqual(d.code, ['python3 plot.py', 'python3 plot.py']);
  assert.equal(d.steps, 3);
  assert.equal(d.usage.inputTokens, 30);
  // The agent is not shown the watch note, and the sandbox container is reused.
  const first = client.requests[0];
  assert.doesNotMatch(JSON.stringify(first), /Hawaiian/);
  assert.match(first.messages[0].content, /Audience: the board/);
  assert.deepEqual(
    first.tools.map((t) => t.name),
    ['run_sql', 'code_execution', 'submit_deliverable']
  );
  assert.equal(first.tool_choice, undefined);
  assert.equal(first.container, undefined);
  assert.equal(client.requests[2].container, 'c1');
});

test('a session with no chart or no submission says so', async () => {
  const noChart = fakeClient([
    {
      content: [
        {
          type: 'tool_use',
          id: 't',
          name: 'submit_deliverable',
          input: { chart_file: 'x.png', title: 't', takeaway: 'k' },
        },
      ],
      stop_reason: 'tool_use',
      usage,
    },
  ]);
  const runSql = async () => ({ ok: true, text: '' });
  const a = await produceDeliverable(noChart, briefs[0], '2026-07', runSql, {
    model: 'm',
    effort: 'low',
  });
  assert.equal(a.error, 'no_chart');
  assert.equal(a.chart, null);
  const silent = fakeClient(
    Array.from({ length: 2 }, () => ({
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
      usage,
    }))
  );
  const b = await produceDeliverable(silent, briefs[0], '2026-07', runSql, {
    model: 'm',
    effort: 'low',
  });
  assert.equal(b.error, 'no_deliverable');
});

const deliverable = {
  briefId: briefs[0].id,
  chart: png,
  chartFile: 'chart.png',
  title: 'T <b>',
  takeaway: 'Up 5%.',
  queries: ['SELECT 1'],
  code: ['plt.bar()'],
  usage: {},
  steps: 1,
};

test('the review input is one chain: queries, chart code, chart, then request and takeaway', () => {
  const input = reviewInput(briefs[0], deliverable);
  assert.equal(input.kind, 'chain');
  assert.deepEqual(
    input.stages.map((s) => s.artifact.kind),
    ['code', 'code', 'image', 'text']
  );
  assert.equal(input.stages[2].artifact.images[0].mediaType, 'image/png');
  assert.match(input.stages[3].artifact.content, /Request from the board/);
  assert.match(input.stages[3].artifact.content, /Up 5%\./);
  // The watch note is for people, not for the reviewer.
  assert.doesNotMatch(JSON.stringify(input), /Hawaiian/);
});

test('the gallery is one self-contained page with escaped text and the findings', () => {
  const report = {
    findings: [
      {
        ruleId: 'truncated-y-axis',
        name: 'Truncated Y-Axis',
        domain: 'Graphical Gaffes',
        severity: 'warning',
        confidence: 'high',
        nature: 'active',
        condition: '',
        evidence: 'axis starts at 70',
        explanation: 'Bars exaggerate <small> gaps.',
        remediation: '',
      },
    ],
    kind: 'chain',
    model: 'm',
    rulesConsidered: 78,
  };
  const html = renderGallery(
    [
      { brief: briefs[0], deliverable, report },
      {
        brief: briefs[1],
        deliverable: { ...deliverable, chart: null, error: 'no_chart' },
        report: null,
        reviewError: 'boom',
      },
    ],
    { model: 'claude-opus-5-5', asOf: '2026-07', reviewModel: 'claude-opus-5-5' }
  );
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /src="data:image\/png;base64,/);
  assert.match(html, /T &lt;b&gt;/);
  assert.match(html, /<code>truncated-y-axis<\/code>/);
  assert.match(html, /exaggerate &lt;small&gt; gaps/);
  assert.match(html, /What a careful answer would notice/);
  assert.match(html, /No chart was produced \(no_chart\)/);
  assert.match(html, /Not reviewed \(boom\)/);
  assert.doesNotMatch(html, /https?:\/\//);
});
