// What the harness asks of any agent under test (PRD 2, B5), and the pieces
// every adapter shares: the task, the result, and the prompt text.
import type { Transcript, TranscriptEvent } from '@datapitfalls/schemas';
import type { Usage } from './pricing.js';
import type { AnswerType, AnswerValue } from './questions.js';
import type { SqlTool } from './sql-tool.js';

/** A note the agent asks to keep. Only offered when the memory setup allows it. */
export interface MemoryNote {
  kind: 'lesson' | 'quirk' | 'decision' | 'hypothesis';
  statement: string;
  pitfall_ids: string[];
  evidence_sql: string | null;
}

export interface AgentTask {
  sessionId: string;
  /** Newest data month the agent can see. */
  asOf: string;
  questionId: string;
  question: string;
  answer: { type: AnswerType; unit?: string };
  /** Persona and this month's memos. */
  context: string;
  /** What the memory setup supplies for this session; empty when there is none. */
  memory: string;
  /** Extra instructions from the memory setup (for example, what memory is for). */
  memoryInstructions: string;
  /** Whether the agent may save notes during the session. */
  canRemember: boolean;
  runSql: SqlTool;
  maxSteps: number;
}

export interface AgentResult {
  /** The submitted answer, or null when the agent gave none. */
  answer: AnswerValue | null;
  explanation: string;
  notes: MemoryNote[];
  transcript: Transcript;
  usage: Usage;
  /** Model requests made. */
  steps: number;
  /** Queries that returned an error. */
  sqlErrors: number;
  /** Set when the session ended without an answer: 'no_answer', 'step_limit', 'refusal' or an API error. */
  error?: string;
}

export interface AgentAdapter {
  /** Short label recorded with results. */
  name: string;
  model: string;
  answer(task: AgentTask): Promise<AgentResult>;
}

export const SCHEMA_BRIEFING = `The database is SQLite and holds U.S. air traffic data from the Bureau of Transportation Statistics (T-100) and OurAirports.

Tables:
- segments: one row per carrier, nonstop leg (origin to dest), aircraft type, service class and month. Columns: scope ('domestic' or 'international'), year, month, carrier_code, carrier_name, carrier_entity, airline_id, carrier_region, carrier_group, origin, origin_airport_id, origin_city_market_id, origin_city_name, origin_state, origin_country, dest, dest_airport_id, dest_city_market_id, dest_city_name, dest_state, dest_country, service_class, distance_miles, passengers, freight_lbs, mail_lbs, aircraft_type_id, aircraft_config, departures_scheduled, departures_performed, seats, payload_lbs, ramp_minutes, air_minutes.
- markets: one row per carrier, on-flight market, service class and month. Same carrier, airport and class columns as segments, with passengers, freight_lbs, mail_lbs and distance_miles.
- airports: OurAirports list (airport_id, ident, iata_code, name, type, municipality, iso_country, iso_region, latitude, longitude, elevation_ft, scheduled_service).
- countries (iso_code, name, continent), carriers (carrier_code, carrier_name), aircraft_types (aircraft_type_id, aircraft_name), service_classes (class_code, description).

State columns are filled for domestic rows and country columns for international rows. Service class 'F' is scheduled passenger service.`;

const ANSWER_HELP: Record<AnswerType, string> = {
  number: 'a single number in `number`',
  percent: 'a single number in `number`, in percent (write 12.5 for 12.5%)',
  entity: 'a single code or name in `text`',
  list: 'the items in order in `list`',
};

/** The system prompt. Stable across sessions of a run, so it can be cached. */
export function systemPrompt(task: Pick<AgentTask, 'canRemember' | 'memoryInstructions'>): string {
  const parts = [
    'You are a data analyst answering one business question from a database.',
    SCHEMA_BRIEFING,
    'How to work: use the run_sql tool to query the data (one SELECT per call; results show at most 50 rows). The data ends at the month named in the request; later months do not exist yet. When you have the answer, call submit_answer once. Give your best answer even when you are unsure, and say what you are unsure about in the explanation.',
  ];
  if (task.memoryInstructions) parts.push(task.memoryInstructions);
  if (task.canRemember) {
    parts.push(
      'Saving notes: nothing from this session carries over unless you save it with the remember tool. Before you call submit_answer, save a note for anything a future session could not work out from the data alone. Reporting standards are announced once and never repeated, so save each one you were given that is not already in memory, in its own words, as a decision. Also save any quirk of the data or near-mistake you ran into. Do not save numbers or answers. Many sessions need no note. Each note needs at least one rule id from the Avoiding Data Pitfalls taxonomy that it helps avoid.'
    );
  }
  return parts.join('\n\n');
}

/** The opening user message: context, memory, then the question. */
export function userPrompt(task: AgentTask): { stable: string; question: string } {
  const stable = [task.context];
  if (task.memory) stable.push(`Memory from earlier work:\n${task.memory}`);
  const unit = task.answer.unit ? ` Unit: ${task.answer.unit}.` : '';
  const question = [
    `The newest month in the data is ${task.asOf}.`,
    `Question: ${task.question}`,
    `Submit ${ANSWER_HELP[task.answer.type]}.${unit}`,
  ].join('\n');
  return { stable: stable.join('\n\n'), question };
}

/** Turn a submit_answer input into the answer the question expects, or null if it does not fit. */
export function readSubmittedAnswer(
  type: AnswerType,
  input: { number?: unknown; text?: unknown; list?: unknown }
): AnswerValue | null {
  if (type === 'number' || type === 'percent') {
    if (typeof input.number === 'number' && Number.isFinite(input.number)) return input.number;
    const fromText =
      typeof input.text === 'string' ? Number(input.text.replace(/[,%\s]/g, '')) : NaN;
    return Number.isFinite(fromText) && typeof input.text === 'string' && input.text.trim()
      ? fromText
      : null;
  }
  if (type === 'entity') {
    if (typeof input.text === 'string' && input.text.trim()) return input.text.trim();
    return null;
  }
  if (Array.isArray(input.list) && input.list.length) return input.list.map(String);
  return null;
}

/** Builds a Transcript (the shared schema) as a session unfolds. */
export class TranscriptRecorder {
  private readonly events: TranscriptEvent[] = [];
  private reruns = 0;
  constructor(
    private readonly sessionId: string,
    private readonly agent: Transcript['agent'],
    private readonly startedAt: string
  ) {}

  private push(event: TranscriptEvent): void {
    this.events.push({ ...event, content: event.content.slice(0, 4000) });
  }
  user(content: string): void {
    this.push({ role: 'user', type: 'message', content });
  }
  agentMessage(content: string): void {
    if (content.trim()) this.push({ role: 'agent', type: 'message', content });
  }
  query(sql: string): void {
    this.push({ role: 'agent', type: 'query', content: 'Query', sql });
  }
  result(content: string, failed: boolean): void {
    if (failed) this.reruns += 1;
    this.push({ role: 'tool', type: 'result', content });
  }
  finish(): Transcript {
    return {
      session_id: this.sessionId,
      agent: this.agent,
      started_at: this.startedAt,
      events: this.events,
      signals: { user_doubt: 0, rerun: this.reruns, correction: 0 },
    };
  }
}
