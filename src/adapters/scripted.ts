// Agents that follow a script instead of calling a model. They cost nothing,
// so they are used to test the harness and scorer end to end and to size a
// run before any money is spent. They are given the gold answers on purpose,
// which no real agent ever is.
import { TranscriptRecorder, userPrompt, type AgentAdapter, type AgentResult } from '../agent.js';
import { NO_USAGE } from '../pricing.js';
import type { AnswerValue, QuestionInstance } from '../questions.js';

export type Script = 'oracle' | 'naive' | 'stale' | 'silent';

export interface ScriptedKey {
  /** Gold and trap answers by question id for a month. */
  current(asOf: string, questionId: string): QuestionInstance | undefined;
  previous(asOf: string, questionId: string): QuestionInstance | undefined;
}

/** Rough token count for sizing prompts without calling a model: about four characters per token. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * oracle: always the gold answer. naive: the trap's answer when the question
 * has a trap, gold otherwise. stale: last month's gold answer. silent: no answer.
 */
export function createScriptedAdapter(script: Script, key: ScriptedKey): AgentAdapter {
  return {
    name: `scripted:${script}`,
    model: 'none',
    async answer(task): Promise<AgentResult> {
      const recorder = new TranscriptRecorder(task.sessionId, 'generic', new Date(0).toISOString());
      const prompt = userPrompt(task);
      recorder.user(`${prompt.stable}\n\n${prompt.question}`);
      const now = key.current(task.asOf, task.questionId);
      const before = key.previous(task.asOf, task.questionId);
      let answer: AnswerValue | null = null;
      if (script === 'oracle') answer = now?.gold.value ?? null;
      if (script === 'naive')
        answer = now?.traps.find((t) => t.value !== null)?.value ?? now?.gold.value ?? null;
      if (script === 'stale') answer = before?.gold.value ?? now?.gold.value ?? null;
      recorder.agentMessage(`Answer: ${JSON.stringify(answer)}`);
      return {
        answer,
        explanation: `scripted (${script})`,
        notes: [],
        transcript: recorder.finish(),
        // Scripted agents spend nothing; prompt size is reported so a run can be sized.
        usage: { ...NO_USAGE },
        steps: 0,
        sqlErrors: 0,
        error: answer === null ? 'no_answer' : undefined,
      };
    },
  };
}
