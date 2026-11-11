// Claude adapter (PRD 2, B5): a manual tool loop over the Messages API.
// The loop is written by hand, not with the SDK's tool runner, because the
// harness needs a hard step limit, per-request token accounting and a full
// transcript of every query.
import Anthropic from '@anthropic-ai/sdk';
import {
  readSubmittedAnswer,
  systemPrompt,
  TranscriptRecorder,
  userPrompt,
  type AgentAdapter,
  type AgentResult,
  type AgentTask,
  type MemoryNote,
} from '../agent.js';
import { addUsage, NO_USAGE, type Usage } from '../pricing.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeAdapterOptions {
  /** Defaults to claude-opus-5-5. */
  model?: string;
  /** Sent as output_config.effort. Defaults to medium. */
  effort?: Effort;
  /** A client to use in place of one built from the environment (tests pass a fake). */
  client?: Pick<Anthropic, 'messages'>;
  maxTokens?: number;
}

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

const RUN_SQL: Anthropic.Tool = {
  name: 'run_sql',
  description:
    'Run one read-only SQLite SELECT against the database and get the rows back as CSV. Use it as often as you need.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: { sql: { type: 'string', description: 'A single SELECT statement.' } },
    required: ['sql'],
    additionalProperties: false,
  },
};

const SUBMIT_ANSWER: Anthropic.Tool = {
  name: 'submit_answer',
  description:
    'Submit the final answer. Call this exactly once, when you are done. Fill the field the question asks for and set the others to null.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      number: { type: ['number', 'null'], description: 'For number and percent answers.' },
      text: { type: ['string', 'null'], description: 'For a single code or name.' },
      list: {
        anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
        description: 'For ordered lists.',
      },
      explanation: { type: 'string', description: 'One or two sentences on how you got it.' },
    },
    required: ['number', 'text', 'list', 'explanation'],
    additionalProperties: false,
  },
};

const REMEMBER: Anthropic.Tool = {
  name: 'remember',
  description:
    'Save a note for future sessions: something that cannot be re-read from the data, such as a quirk of the data, a lesson about a mistake to avoid, or a decision about how something is defined.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['lesson', 'quirk', 'decision', 'hypothesis'] },
      statement: { type: 'string', description: 'The note, in one or two plain sentences.' },
      pitfall_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Avoiding Data Pitfalls rule ids this note helps avoid.',
      },
      evidence_sql: {
        type: ['string', 'null'],
        description: 'A query that shows the evidence, if there is one.',
      },
    },
    required: ['kind', 'statement', 'pitfall_ids', 'evidence_sql'],
    additionalProperties: false,
  },
};

function usageOf(u: Anthropic.Usage): Usage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** Errors that will not get better by trying the next session: stop the run. */
export function isFatalApiError(error: unknown): boolean {
  return (
    error instanceof Anthropic.AuthenticationError ||
    error instanceof Anthropic.PermissionDeniedError ||
    error instanceof Anthropic.BadRequestError ||
    error instanceof Anthropic.NotFoundError
  );
}

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const model = options.model ?? DEFAULT_CLAUDE_MODEL;
  const effort = options.effort ?? 'medium';
  // Rate limits and server errors are retried by the SDK before they reach us.
  const client = options.client ?? new Anthropic({ maxRetries: 4 });

  async function answer(task: AgentTask): Promise<AgentResult> {
    const recorder = new TranscriptRecorder(task.sessionId, 'claude', new Date().toISOString());
    const prompt = userPrompt(task);
    recorder.user(`${prompt.stable}\n\n${prompt.question}`);
    const tools = task.canRemember ? [RUN_SQL, SUBMIT_ANSWER, REMEMBER] : [RUN_SQL, SUBMIT_ANSWER];
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: [
          // Context and memory are the same for every question in a month, so
          // they sit before the cache breakpoint; the question comes after it.
          { type: 'text', text: prompt.stable, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: prompt.question },
        ],
      },
    ];
    const result: AgentResult = {
      answer: null,
      explanation: '',
      notes: [],
      transcript: recorder.finish(),
      usage: NO_USAGE,
      steps: 0,
      sqlErrors: 0,
    };
    let nudged = false;

    try {
      while (result.steps < task.maxSteps) {
        const response = await client.messages.create({
          model,
          max_tokens: options.maxTokens ?? 16000,
          output_config: { effort },
          system: [
            { type: 'text', text: systemPrompt(task), cache_control: { type: 'ephemeral' } },
          ],
          tools,
          messages,
        });
        result.steps += 1;
        result.usage = addUsage(result.usage, usageOf(response.usage));
        messages.push({ role: 'assistant', content: response.content });
        for (const block of response.content) {
          if (block.type === 'text') recorder.agentMessage(block.text);
        }

        if (response.stop_reason === 'refusal') {
          result.error = 'refusal';
          break;
        }
        if (response.stop_reason === 'max_tokens') {
          result.error = 'max_tokens';
          break;
        }
        const calls = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
        );
        if (!calls.length) {
          // The model stopped without submitting. Ask once, then give up.
          if (nudged) {
            result.error = 'no_answer';
            break;
          }
          nudged = true;
          messages.push({
            role: 'user',
            content: 'Call submit_answer with your best answer now.',
          });
          continue;
        }

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        let submitted = false;
        for (const call of calls) {
          const input = call.input as Record<string, unknown>;
          if (call.name === 'run_sql') {
            const sql = String(input.sql ?? '');
            recorder.query(sql);
            const out = await task.runSql(sql);
            if (!out.ok) result.sqlErrors += 1;
            recorder.result(out.text, !out.ok);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: out.text,
              is_error: !out.ok,
            });
          } else if (call.name === 'remember') {
            result.notes.push(input as unknown as MemoryNote);
            toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: 'Saved.' });
          } else if (call.name === 'submit_answer') {
            result.answer = readSubmittedAnswer(task.answer.type, input);
            result.explanation = String(input.explanation ?? '');
            recorder.agentMessage(
              `Answer: ${JSON.stringify(result.answer)}. ${result.explanation}`
            );
            submitted = true;
            toolResults.push({ type: 'tool_result', tool_use_id: call.id, content: 'Recorded.' });
          } else {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: call.id,
              content: `Unknown tool ${call.name}`,
              is_error: true,
            });
          }
        }
        if (submitted) {
          if (result.answer === null) result.error = 'no_answer';
          break;
        }
        messages.push({ role: 'user', content: toolResults });
      }
      if (result.answer === null && !result.error) result.error = 'step_limit';
    } catch (error) {
      if (isFatalApiError(error)) throw error;
      if (error instanceof Anthropic.RateLimitError) result.error = 'rate_limited';
      else if (error instanceof Anthropic.APIConnectionError) result.error = 'connection_error';
      else if (error instanceof Anthropic.APIError) result.error = `api_error_${error.status}`;
      else throw error;
    }
    result.transcript = recorder.finish();
    return result;
  }

  return { name: `claude:${model}:${effort}`, model, answer };
}
