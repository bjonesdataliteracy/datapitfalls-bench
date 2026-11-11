// Offline tests for the harness: context, SQL tool, Claude adapter (with a
// fake client), memory setups, scorer and runner. Nothing here calls an API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  cachedAnswers,
  compareSetups,
  contextFor,
  costUsd,
  createClaudeAdapter,
  createScriptedAdapter,
  createSetupFactory,
  createSqlTool,
  debriefMemory,
  estimateSessionCost,
  loadQuestionSet,
  loadTimeline,
  logAll,
  metricsCsv,
  noMemory,
  pitfallMemory,
  priceFor,
  readRun,
  readSubmittedAnswer,
  renderContext,
  runBenchmark,
  scoreSession,
  summarizeBySetup,
} from '../dist/index.js';
import { buildFixtureDb } from './helpers.mjs';

const { dir, path } = buildFixtureDb();
test.after(() => rmSync(dir, { recursive: true, force: true }));
const repo = (rel) => new URL(`../${rel}`, import.meta.url).pathname;
const realSet = loadQuestionSet(repo('questions/questions.yaml'));

// ---- context ---------------------------------------------------------------

test('the timeline announces every standard exactly once', () => {
  const timeline = loadTimeline(repo('context/timeline.yaml'), realSet.standards);
  const announced = timeline.memos.map((m) => m.standard).filter(Boolean);
  assert.deepEqual([...announced].sort(), realSet.standards.map((s) => s.id).sort());
});

test('announce-once shows a memo only in its month; always repeats it', () => {
  const timeline = loadTimeline(repo('context/timeline.yaml'), realSet.standards);
  const first = contextFor(timeline, '2024-08', '2024-08', 'announce-once');
  assert.equal(first.memos.length, 6);
  assert.equal(first.persona.name, 'Network planning');
  assert.equal(contextFor(timeline, '2024-09', '2024-08', 'announce-once').memos.length, 0);
  const jan = contextFor(timeline, '2026-01', '2024-08', 'announce-once');
  assert.deepEqual(
    jan.memos.map((m) => m.standard),
    ['alaska-includes-hawaiian']
  );
  assert.equal(contextFor(timeline, '2026-03', '2024-08', 'always').memos.length, 7);
  assert.equal(
    contextFor(timeline, '2026-03', '2024-08', 'always').persona.name,
    'Investor relations'
  );
  // A run that starts after a memo's month still issues it, in the run's first month.
  assert.equal(contextFor(timeline, '2026-02', '2026-02', 'announce-once').memos.length, 7);
  assert.match(renderContext(first), /Load factor is total passengers divided by total seats/);
});

test('a timeline naming an unknown standard is refused', () => {
  const bad = join(dir, 'timeline-bad.yaml');
  writeFileSync(
    bad,
    yaml.dump({
      personas: [{ from: '2024-08', name: 'x', text: 'y' }],
      memos: [{ month: '2024-08', standard: 'nope' }],
    })
  );
  assert.throws(() => loadTimeline(bad, realSet.standards), /unknown standard "nope"/);
});

// ---- SQL tool ---------------------------------------------------------------

test('the SQL tool returns CSV, reports errors as text, and stops runaway queries', async () => {
  const runSql = createSqlTool(path, { maxRows: 2, timeoutMs: 400 });
  const ok = await runSql(
    "SELECT year, month FROM segments WHERE scope = 'domestic' ORDER BY month"
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.text.split('\n')[0], 'year,month');
  assert.match(ok.text, /only the first 2 rows/);
  assert.equal((await runSql('SELECT 1 WHERE 0')).text, '(no rows)');
  const write = await runSql('DELETE FROM segments');
  assert.deepEqual([write.ok, /Only SELECT/.test(write.text)], [false, true]);
  const typo = await runSql('SELECT nope FROM segments');
  assert.deepEqual([typo.ok, /no such column/.test(typo.text)], [false, true]);
  const forever = await runSql(
    'WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r) SELECT COUNT(*) FROM r'
  );
  assert.deepEqual([forever.ok, /stopped after/.test(forever.text)], [false, true]);
});

// ---- Claude adapter, with a fake client ---------------------------------------

const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_input_tokens: 5,
  cache_creation_input_tokens: 7,
};
const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input });
const reply = (content, stop_reason = 'tool_use') => ({ content, stop_reason, usage });
function fakeClient(replies) {
  const requests = [];
  return {
    requests,
    messages: {
      create: async (params) => {
        requests.push(structuredClone(params));
        const next = replies.shift();
        if (!next) throw new Error('fake client ran out of replies');
        return next;
      },
    },
  };
}
const task = (over = {}) => ({
  sessionId: 's1',
  asOf: '2099-03',
  questionId: 'q',
  question: 'How many?',
  answer: { type: 'number', unit: 'passengers' },
  context: 'Who you are working for: test.',
  memory: '',
  memoryInstructions: '',
  canRemember: false,
  runSql: createSqlTool(path),
  maxSteps: 6,
  ...over,
});

test('the adapter loops over queries, then records the submitted answer', async () => {
  const client = fakeClient([
    reply([
      { type: 'text', text: 'Let me look.' },
      toolUse('t1', 'run_sql', {
        sql: "SELECT SUM(passengers) AS p FROM segments WHERE month = 3 AND scope = 'domestic'",
      }),
    ]),
    reply([
      toolUse('t2', 'submit_answer', {
        number: 180,
        text: null,
        list: null,
        explanation: 'Summed it.',
      }),
    ]),
  ]);
  const result = await createClaudeAdapter({ client }).answer(task());
  assert.equal(result.answer, 180);
  assert.equal(result.steps, 2);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.usage, {
    inputTokens: 200,
    outputTokens: 40,
    cacheReadTokens: 10,
    cacheWriteTokens: 14,
  });
  // The query result went back to the model as a tool_result.
  const second = client.requests[1].messages.at(-1);
  assert.equal(second.content[0].type, 'tool_result');
  assert.match(second.content[0].content, /^p\n180/);
  // The transcript follows the shared schema's shape and carries the SQL.
  assert.deepEqual(
    result.transcript.events.map((e) => `${e.role}:${e.type}`),
    ['user:message', 'agent:message', 'agent:query', 'tool:result', 'agent:message']
  );
  assert.match(result.transcript.events[2].sql, /SUM\(passengers\)/);
});

test('requests use the default model, effort, strict tools and no forced tool choice', async () => {
  const client = fakeClient([
    reply([toolUse('t', 'submit_answer', { number: 1, text: null, list: null, explanation: '' })]),
  ]);
  const adapter = createClaudeAdapter({ client });
  await adapter.answer(task({ memory: 'a note', memoryInstructions: 'What memory is for: x' }));
  const [request] = client.requests;
  assert.equal(adapter.model, 'claude-opus-5-5');
  assert.equal(request.model, 'claude-opus-5-5');
  assert.deepEqual(request.output_config, { effort: 'medium' });
  assert.equal(request.tool_choice, undefined);
  assert.equal(request.thinking, undefined);
  assert.equal(request.temperature, undefined);
  assert.deepEqual(
    request.tools.map((t) => [t.name, t.strict]),
    [
      ['run_sql', true],
      ['submit_answer', true],
    ]
  );
  assert.equal(request.system[0].cache_control.type, 'ephemeral');
  assert.match(request.system[0].text, /What memory is for/);
  // Context and memory sit before the cache breakpoint; the question after it.
  const [stable, question] = request.messages[0].content;
  assert.equal(stable.cache_control.type, 'ephemeral');
  assert.match(stable.text, /a note/);
  assert.equal(question.cache_control, undefined);
  assert.match(question.text, /How many\?/);
});

test('parallel tool calls are answered together in one message, and notes are kept', async () => {
  const client = fakeClient([
    reply([
      toolUse('a', 'run_sql', { sql: 'SELECT 1 AS x' }),
      toolUse('b', 'run_sql', { sql: 'SELECT nope' }),
      toolUse('c', 'remember', {
        kind: 'quirk',
        statement: 'PBI is missing from airports.',
        pitfall_ids: ['join-key-mismatch-row-loss'],
        evidence_sql: null,
      }),
    ]),
    reply([
      toolUse('d', 'submit_answer', { number: null, text: 'WN', list: null, explanation: '' }),
    ]),
  ]);
  const result = await createClaudeAdapter({ client }).answer(
    task({ answer: { type: 'entity' }, canRemember: true })
  );
  const results = client.requests[1].messages.at(-1).content;
  assert.deepEqual(
    results.map((r) => [r.tool_use_id, Boolean(r.is_error)]),
    [
      ['a', false],
      ['b', true],
      ['c', false],
    ]
  );
  assert.equal(result.answer, 'WN');
  assert.equal(result.sqlErrors, 1);
  assert.equal(result.notes.length, 1);
  assert.equal(result.transcript.signals.rerun, 1);
  assert.deepEqual(
    client.requests[0].tools.map((t) => t.name),
    ['run_sql', 'submit_answer', 'remember']
  );
});

test('a session that never submits ends with a reason, not an answer', async () => {
  const text = (t) => reply([{ type: 'text', text: t }], 'end_turn');
  const nudged = fakeClient([text('It is 5.'), text('Still 5.')]);
  const a = await createClaudeAdapter({ client: nudged }).answer(task());
  assert.deepEqual([a.answer, a.error, a.steps], [null, 'no_answer', 2]);
  assert.match(nudged.requests[1].messages.at(-1).content, /submit_answer/);
  const looping = fakeClient(
    Array.from({ length: 3 }, (_, i) => reply([toolUse(`t${i}`, 'run_sql', { sql: 'SELECT 1' })]))
  );
  const b = await createClaudeAdapter({ client: looping }).answer(task({ maxSteps: 3 }));
  assert.deepEqual([b.answer, b.error, b.steps], [null, 'step_limit', 3]);
  const refused = fakeClient([reply([], 'refusal')]);
  assert.equal((await createClaudeAdapter({ client: refused }).answer(task())).error, 'refusal');
  const wrongShape = fakeClient([
    reply([
      toolUse('t', 'submit_answer', { number: null, text: null, list: null, explanation: '' }),
    ]),
  ]);
  assert.equal(
    (await createClaudeAdapter({ client: wrongShape }).answer(task())).error,
    'no_answer'
  );
});

test('submitted answers are read by the type the question expects', () => {
  assert.equal(readSubmittedAnswer('number', { number: 12.5 }), 12.5);
  assert.equal(readSubmittedAnswer('percent', { number: null, text: '12.5%' }), 12.5);
  assert.equal(readSubmittedAnswer('number', { number: null, text: '1,234' }), 1234);
  assert.equal(readSubmittedAnswer('number', { number: null, text: '' }), null);
  assert.equal(readSubmittedAnswer('entity', { text: ' WN ' }), 'WN');
  assert.deepEqual(readSubmittedAnswer('list', { list: ['UA', 'AA'] }), ['UA', 'AA']);
  assert.equal(readSubmittedAnswer('list', { list: [] }), null);
});

// ---- memory setups -------------------------------------------------------------

const info = (asOf, questionId = 'q1') => ({
  sessionId: `${asOf}-${questionId}`,
  asOf,
  questionId,
  question: 'How many?',
  context: 'ctx',
});
const result = (over = {}) => ({
  answer: 42,
  explanation: 'because',
  notes: [],
  transcript: {
    session_id: 's',
    agent: 'generic',
    started_at: 'x',
    events: [{ role: 'agent', type: 'query', content: 'Query', sql: 'SELECT  1' }],
  },
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  steps: 1,
  sqlErrors: 0,
  ...over,
});
const resolveRuleId = (id) =>
  ({
    'join-key-mismatch-row-loss': 'join-key-mismatch-row-loss',
    'old-name': 'unweighted-rate-average',
    'unweighted-rate-average': 'unweighted-rate-average',
  })[id];

test('what a setup learns in a month is visible only from the next month', async () => {
  for (const setup of [logAll(), cachedAnswers()]) {
    assert.equal(setup.beforeSession(info('2099-01')), '');
    setup.afterSession(info('2099-01'), result());
    assert.equal(setup.beforeSession(info('2099-01')), '', `${setup.name} leaked within the month`);
    await setup.nightly('2099-01');
    assert.match(setup.beforeSession(info('2099-02')), /42/);
  }
  const none = noMemory();
  none.afterSession(info('2099-01'), result());
  await none.nightly('2099-01');
  assert.equal(none.beforeSession(info('2099-02')), '');
});

test('log-all keeps context, queries and answers; cache keeps one answer per question', async () => {
  const log = logAll();
  log.afterSession(info('2099-01', 'q1'), result());
  log.afterSession(info('2099-01', 'q2'), result({ answer: null }));
  await log.nightly('2099-01');
  const text = log.beforeSession(info('2099-02'));
  assert.match(text, /Context: ctx/);
  assert.equal(text.match(/Context:/g).length, 1);
  assert.match(text, /SQL: SELECT 1/);
  assert.match(text, /\(no answer\)/);
  const cache = cachedAnswers();
  cache.afterSession(info('2099-01', 'q1'), result());
  await cache.nightly('2099-01');
  cache.afterSession(info('2099-02', 'q1'), result({ answer: 43 }));
  await cache.nightly('2099-02');
  assert.match(cache.beforeSession(info('2099-03', 'q1')), /as of 2099-02\): 43/);
  assert.equal(cache.beforeSession(info('2099-03', 'other')), '');
  assert.deepEqual(cache.size(), { records: 1, lines: 1 });
});

test('pitfall memory keeps notes that cite a real rule, resolves aliases, and drops the rest', async () => {
  const memory = pitfallMemory({ resolveRuleId, taxonomyVersion: 'abc' });
  assert.equal(memory.canRemember, true);
  assert.match(memory.instructions, /What memory is for/);
  const note = (statement, pitfall_ids, kind = 'quirk') => ({
    kind,
    statement,
    pitfall_ids,
    evidence_sql: 'SELECT 1',
  });
  memory.afterSession(
    info('2099-01'),
    result({
      notes: [
        note('PBI has no match in airports.', ['join-key-mismatch-row-loss']),
        note('Use weighted load factor.', ['old-name'], 'decision'),
        note('No rule cited.', []),
        note('Made-up rule.', ['not-a-rule']),
        note('pbi has no match in AIRPORTS', ['join-key-mismatch-row-loss']), // duplicate
      ],
    })
  );
  await memory.nightly('2099-01');
  const records = memory.records();
  assert.equal(records.length, 2);
  assert.equal(memory.rejectedNotes(), 2);
  assert.deepEqual(
    records.map((r) => r.record.pitfall_ids),
    [['join-key-mismatch-row-loss'], ['unweighted-rate-average']]
  );
  assert.ok(
    records.every(
      (r) =>
        r.origin === 'agent' &&
        r.record.taxonomyVersion === 'abc' &&
        r.record.pitfall_ids.length >= 1
    )
  );
  const index = memory.beforeSession(info('2099-02'));
  assert.match(
    index,
    /^- \[decision\] Use weighted load factor\. \(unweighted-rate-average\)\n- \[quirk\] PBI/
  );
  assert.deepEqual(memory.size(), { records: 2, lines: 2 });
});

test('Debrief turns solid findings into lessons, a few per rule, and reports its usage', async () => {
  const reviewed = [];
  const finding = (over) => ({
    ruleId: 'unweighted-rate-average',
    name: 'n',
    domain: 'Mathematical Miscues',
    severity: 'warning',
    confidence: 'high',
    nature: 'active',
    condition: '',
    evidence: 'e',
    explanation: 'Averaged row rates.',
    remediation: 'Divide totals.',
    eventRefs: [2],
    ...over,
  });
  const memory = debriefMemory({
    resolveRuleId,
    reviewModel: 'claude-sonnet-4-6',
    maxReviewsPerMonth: 2,
    maxLessonsPerRule: 1,
    review: async (transcript) => {
      reviewed.push(transcript.session_id);
      return {
        findings: [
          finding({}),
          finding({ confidence: 'low', explanation: 'Low.' }),
          finding({ nature: 'latent', explanation: 'Latent.' }),
          finding({ ruleId: 'not-a-rule', explanation: 'Unknown.' }),
        ],
        kind: 'transcript',
        model: 'm',
        rulesConsidered: 78,
        taxonomyVersion: 'abc',
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadInputTokens: 10,
          cacheCreationInputTokens: 20,
        },
      };
    },
  });
  const session = (id, sqlErrors) =>
    result({
      sqlErrors,
      transcript: { session_id: id, agent: 'generic', started_at: 'x', events: [] },
    });
  memory.afterSession(info('2099-01', 'a'), session('clean-1', 0));
  memory.afterSession(info('2099-01', 'b'), session('errors', 3));
  memory.afterSession(info('2099-01', 'c'), session('clean-2', 0));
  const night = await memory.nightly('2099-01');
  assert.equal(reviewed.length, 2);
  assert.equal(reviewed[0], 'errors'); // sessions with query errors are reviewed first
  assert.deepEqual(night, {
    usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 20, cacheWriteTokens: 40 },
    model: 'claude-sonnet-4-6',
  });
  const records = memory.records();
  assert.equal(records.length, 1); // one rule, capped at one lesson; low, latent and unknown dropped
  assert.equal(records[0].origin, 'debrief');
  assert.equal(records[0].record.statement, 'Averaged row rates. Divide totals.');
  assert.deepEqual(records[0].record.evidence[0].events, [2]);
  assert.equal(memory.name, 'debrief');
  assert.match(memory.beforeSession(info('2099-02')), /\[lesson\] Averaged row rates/);
});

// ---- scorer -----------------------------------------------------------------

const instance = (gold, traps = []) => ({
  id: 'q',
  category: 'level',
  asOf: '2099-03',
  text: 't',
  answer: { type: 'number' },
  standards: [],
  gold: { value: gold, aliases: [] },
  traps,
});
const sess = (setup, answer, over = {}) => ({
  setup,
  asOf: '2099-03',
  questionId: 'q',
  answer,
  usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  memoryTokens: 5,
  steps: 2,
  ...over,
});

test('an answer is correct, a pitfall error, stale, wrong or missing, in that order', () => {
  const now = instance(1000, [{ id: 'trap', value: 500, differs: true, active: true }]);
  const before = instance(800);
  const outcome = (answer, n = now, b = before) => scoreSession(sess('s', answer), n, b).outcome;
  assert.equal(outcome(1005), 'correct');
  assert.equal(outcome(500), 'pitfall');
  assert.equal(scoreSession(sess('s', 500), now, before).trapId, 'trap');
  assert.equal(outcome(800), 'stale');
  assert.equal(outcome(123), 'wrong');
  assert.equal(outcome(null), 'no_answer');
  // A trap outside its window is not counted as that pitfall.
  assert.equal(
    outcome(500, instance(1000, [{ id: 'trap', value: 500, differs: true, active: false }])),
    'wrong'
  );
  // When gold did not change, repeating it is simply correct, and nothing can be stale.
  assert.equal(outcome(1000, instance(1000), instance(1000)), 'correct');
  assert.equal(scoreSession(sess('s', 7), instance(1000), instance(1000)).goldChanged, false);
  assert.equal(scoreSession(sess('s', 7), instance(1000), undefined).goldChanged, false);
});

test('metrics use the right denominators', () => {
  const trap = instance(1000, [{ id: 'trap', value: 500, differs: true, active: true }]);
  const scored = [
    scoreSession(sess('a', 1000), trap, instance(800)),
    scoreSession(sess('a', 500), trap, instance(800)),
    scoreSession(sess('a', 800, { questionId: 'q2' }), instance(1000), instance(800)),
    scoreSession(sess('a', null, { questionId: 'q3' }), instance(1000), instance(1000)),
  ];
  const { overall, byMonth } = summarizeBySetup(scored);
  const m = overall.a;
  assert.equal(m.accuracy, 0.25);
  assert.equal(m.pitfallErrorRate, 0.5); // 1 of the 2 trap-active sessions
  assert.equal(m.staleAnswerRate, 1 / 3); // 1 of the 3 where gold changed
  assert.equal(m.noAnswerRate, 0.25);
  assert.equal(m.tokensPerQuestion, 110);
  assert.equal(m.memoryTokensPerQuestion, 5);
  assert.deepEqual(Object.keys(byMonth.a), ['2099-03']);
  const csv = metricsCsv({ overall, byMonth }).trim().split('\n');
  assert.equal(
    csv[0],
    'setup,month,sessions,accuracy,stale_answer_rate,pitfall_error_rate,no_answer_rate,tokens_per_question,memory_tokens_per_question'
  );
  assert.equal(csv[2], 'a,all,4,0.25,0.3333,0.5,0.25,110,5');
  assert.equal(summarizeBySetup([]).overall.a, undefined);
});

test('setups are compared on the question-months both answered', () => {
  const trap = instance(1000, [{ id: 'trap', value: 500, differs: true, active: true }]);
  const scored = [];
  for (let i = 0; i < 40; i++) {
    const q = { questionId: `q${i}` };
    scored.push(scoreSession(sess('debrief', 1000, q), trap, undefined));
    scored.push(scoreSession(sess('cache', i < 30 ? 500 : 1000, q), trap, undefined));
  }
  scored.push(scoreSession(sess('debrief', 1, { questionId: 'unpaired' }), trap, undefined));
  const c = compareSetups(scored, 'debrief', 'cache', { seed: 7 });
  assert.equal(c.pairs, 40);
  assert.equal(c.accuracyDiffPoints, 75);
  assert.ok(c.accuracyInterval[0] > 50 && c.accuracyInterval[1] <= 100);
  assert.deepEqual(c.pitfallRate, { setup: 0, baseline: 0.75, reductionPct: 100 });
  assert.deepEqual(
    compareSetups(scored, 'debrief', 'cache', { seed: 7 }).accuracyInterval,
    c.accuracyInterval
  );
});

test('costs follow the price table, and an unknown model cannot be budgeted', () => {
  const u = {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 1_000_000,
  };
  assert.equal(costUsd('claude-opus-5-5', u), 4 + 20 + 0.2 + 5);
  assert.throws(() => priceFor('some-new-model'), /No price is recorded/);
  const a = { steps: 6, outputTokensPerStep: 500, addedTokensPerStep: 600 };
  assert.ok(
    estimateSessionCost('claude-opus-5-5', 1000, a) >
      estimateSessionCost('claude-sonnet-5-5', 1000, a)
  );
  assert.ok(
    estimateSessionCost('claude-opus-5-5', 50_000, a) >
      estimateSessionCost('claude-opus-5-5', 1000, a)
  );
});

// ---- runner, end to end with scripted agents -------------------------------------

const questionsFile = join(dir, 'run-questions.yaml');
writeFileSync(
  questionsFile,
  yaml.dump({
    standards: [{ id: 'std', text: 'Count domestic only.' }],
    questions: [
      {
        id: 'domestic',
        category: 'level',
        text: 'Domestic passengers in {latest_month}?',
        answer: { type: 'number' },
        standards: ['std'],
        gold_sql:
          "SELECT SUM(passengers) FROM segments WHERE year = :y AND month = :m AND scope = 'domestic'",
        traps: [
          {
            id: 'airport-join-drops-palm-beach',
            sql: 'SELECT SUM(passengers) FROM segments WHERE year = :y AND month = :m',
          },
        ],
      },
      {
        id: 'carrier',
        category: 'ranking',
        text: 'Largest carrier in {latest_month}?',
        answer: { type: 'entity' },
        gold_sql:
          'SELECT carrier_code FROM segments WHERE year = :y AND month = :m GROUP BY 1 ORDER BY SUM(passengers) DESC LIMIT 1',
      },
    ],
  })
);
const timelineFile = join(dir, 'run-timeline.yaml');
writeFileSync(
  timelineFile,
  yaml.dump({
    personas: [{ from: '2099-01', name: 'p', text: 'You work for a test team.' }],
    memos: [{ month: '2099-02', standard: 'std' }],
  })
);
// A catalog whose trap window covers the fixture's months.
const catalogFile = join(dir, 'run-catalog.yaml');
writeFileSync(
  catalogFile,
  yaml.dump([{ id: 'airport-join-drops-palm-beach', start_month: '2099-01' }])
);
const taxonomy = {
  resolveRuleId,
  taxonomyVersion: 'abc',
  defaultModel: 'claude-sonnet-4-6',
  review: async () => ({ findings: [], kind: 'transcript', model: 'm', rulesConsidered: 0 }),
};
const config = (out, over = {}) => ({
  db: path,
  from: '2099-02',
  to: '2099-05',
  setups: ['none', 'log-all', 'cache', 'pitfall', 'debrief'],
  outDir: join(dir, out),
  budgetUsd: 1,
  questionsFile,
  catalogFile,
  timelineFile,
  ...over,
});
const deps = (script) => ({
  createSetup: createSetupFactory(taxonomy),
  createAgent: (key) => createScriptedAdapter(script, key),
});
const scoreRun = (outDir) => {
  const { sessions, gold } = readRun(outDir);
  const find = (month, id) => gold[month]?.find((q) => q.id === id);
  const prior = (month) => `2099-0${Number(month.slice(-1)) - 1}`;
  return sessions.map((s) =>
    scoreSession(s, find(s.asOf, s.questionId), find(prior(s.asOf), s.questionId))
  );
};

test('a scripted run goes end to end and scores as its script predicts', async () => {
  const before = readFileSync(path);
  const summary = await runBenchmark(config('run-oracle'), deps('oracle'));
  assert.equal(summary.sessions, 5 * 4 * 2);
  assert.equal(summary.spentUsd, 0);
  assert.equal(summary.stoppedForBudget, false);
  assert.deepEqual(Object.keys(summary.promptTokensPerSession).sort(), [
    'cache',
    'debrief',
    'log-all',
    'none',
    'pitfall',
  ]);
  // log-all's prompt grows with its log; no-memory's does not.
  assert.ok(summary.promptTokensPerSession['log-all'] > summary.promptTokensPerSession.none);
  for (const file of [
    'config.json',
    'gold.json',
    'sessions.jsonl',
    'summary.json',
    'memory/log-all/2099-05.json',
  ]) {
    assert.ok(existsSync(join(summary.outDir, file)), `${file} was not written`);
  }
  // As-of databases are removed after use, and the source database is untouched.
  assert.ok(!existsSync(join(summary.outDir, 'asof', 'asof-2099-02.db')));
  assert.ok(before.equals(readFileSync(path)));
  const oracle = summarizeBySetup(scoreRun(summary.outDir)).overall;
  for (const setup of Object.keys(oracle)) assert.equal(oracle[setup].accuracy, 1, setup);

  const naive = await runBenchmark(config('run-naive', { setups: ['none'] }), deps('naive'));
  const n = summarizeBySetup(scoreRun(naive.outDir)).overall.none;
  assert.equal(n.pitfallErrorRate, 1);
  assert.equal(n.accuracy, 0.5); // the control question has no trap, so naive answers it correctly

  const stale = await runBenchmark(
    config('run-stale', { setups: ['none'], questionIds: ['domestic'] }),
    deps('stale')
  );
  const s = summarizeBySetup(scoreRun(stale.outDir)).overall.none;
  assert.equal(s.sessions, 4);
  assert.equal(s.staleAnswerRate, 1);
});

test('the agent is told the standard only in its month unless context mode is always', async () => {
  const seen = [];
  const spy = {
    createSetup: createSetupFactory(taxonomy),
    createAgent: () => ({
      name: 'spy',
      model: 'none',
      answer: async (t) => {
        seen.push([t.asOf, /Count domestic only/.test(t.context)]);
        return result({ answer: 1 });
      },
    }),
  };
  await runBenchmark(config('run-once', { setups: ['none'], questionIds: ['carrier'] }), spy);
  assert.deepEqual(seen, [
    ['2099-02', true],
    ['2099-03', false],
    ['2099-04', false],
    ['2099-05', false],
  ]);
  seen.length = 0;
  await runBenchmark(
    config('run-always', { setups: ['none'], questionIds: ['carrier'], contextMode: 'always' }),
    spy
  );
  assert.ok(seen.every(([, told]) => told));
});

test('a run stops at its budget, and refuses a folder that already holds a run', async () => {
  const pricey = {
    createSetup: createSetupFactory(taxonomy),
    createAgent: () => ({
      name: 'pricey',
      model: 'claude-opus-5-5',
      answer: async () =>
        result({
          usage: { inputTokens: 100_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        }),
    }),
  };
  // Each session costs $0.40, so a $1 budget allows three.
  const summary = await runBenchmark(
    config('run-budget', { setups: ['none'], concurrency: 1 }),
    pricey
  );
  assert.equal(summary.stoppedForBudget, true);
  assert.equal(summary.sessions, 3);
  assert.ok(Math.abs(summary.spentUsd - 1.2) < 1e-9);
  await assert.rejects(runBenchmark(config('run-budget'), pricey), /already holds a run/);
  await assert.rejects(
    runBenchmark(config('run-zero', { budgetUsd: 0 }), pricey),
    /budget above zero/
  );
});
