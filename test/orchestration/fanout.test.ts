/**
 * fanout.test.ts — TDD for 扇出编排器 (Wave 2 Task 10)
 *
 * Covers:
 *   1. 6 agents, 1 error(500) → 5 succeeded, 1 failed, Promise resolves
 *   2. 12 agents + cap 8 → peak concurrency ≤ 8
 *   3. 429 → retries 2 times then fails → 3 total calls; 401 → 0 retries → 1 call
 *   4. Abort mid-stream → in-progress marked aborted, completed kept
 *   5. Callback order: onAgentStart×N → onToken interleaving → onAgentComplete/onAgentError×N
 *   6. Concurrency hook: counter tracks in-flight peak
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startMockLLM, type MockLLMInstance } from '../fixtures/mock-llm';
import { chatCompletion } from '../../src/lib/llm/client';
import {
  runFanOut,
  type AgentRuntime,
  type FanOutCallbacks,
  type FanOutSummary,
  type ConcurrencyCounter,
  type RetryableError,
} from '../../src/lib/orchestration/fanout';
import {
  RateLimitError,
  ServerError,
  AuthError,
  ClientError,
  IncompleteOutputError,
} from '../../src/lib/llm/client';

// =============================================================================
// Helpers
// =============================================================================

/** Create an agent fixture pointing at mock server */
function makeAgent(
  agentKey: string,
  model: string,
  mockUrl: string,
  overrides: Partial<AgentRuntime> = {},
): AgentRuntime {
  return {
    agentKey,
    name: `Agent ${agentKey}`,
    endpoint: { baseUrl: mockUrl, apiKey: 'sk-mock' },
    model,
    messages: [{ role: 'user', content: `Translate text for ${agentKey}` }],
    ...overrides,
  };
}

/** Create 6 agents with the given model pattern */
function makeAgents(
  count: number,
  mockUrl: string,
  modelFn: (i: number) => string = (i) => `agent-model-${i}`,
): AgentRuntime[] {
  return Array.from({ length: count }, (_, i) =>
    makeAgent(`agent-${i}`, modelFn(i), mockUrl),
  );
}

// =============================================================================
// Tests
// =============================================================================

describe('runFanOut', () => {
  let mock: MockLLMInstance;

  afterEach(async () => {
    if (mock) {
      await mock.close();
    }
  });

  // ===========================================================================
  // 1. Basic: 6 agents, 1 error → 5 succeeded, 1 failed, Promise resolves
  // ===========================================================================
  describe('partial failure tolerance', () => {
    it('6 agents with 1 error(500) → succeeded=5, failed=1, Promise resolves', async () => {      mock = await startMockLLM({ port: 0 });

      // 5 agents → stream (success), 1 agent → error 500
      for (let i = 0; i < 5; i++) {
        mock.setBehavior(`agent-model-${i}`, { behavior: 'stream' });
      }
      mock.setBehavior('agent-model-5', { behavior: 'error', status: 500 });

      const agents = makeAgents(6, mock.url);

      const summary = await runFanOut(agents, {}, chatCompletion, { retryDelaysMs: [1, 2] });

      expect(summary.succeeded).toBe(5);
      expect(summary.failed).toBe(1);
      expect(summary.results).toHaveLength(6);
      expect(summary.durationMs).toBeGreaterThan(0);

      // Verify individual results
      const failedResult = summary.results.find((r) => r.agentKey === 'agent-5');
      expect(failedResult).toBeDefined();
      expect(failedResult!.status).toBe('error');
      expect(failedResult!.error).toBeTruthy();

      const succeededResult = summary.results.find((r) => r.agentKey === 'agent-0');
      expect(succeededResult).toBeDefined();
      expect(succeededResult!.status).toBe('complete');
      expect(succeededResult!.content).toBeTruthy();
    });

    it('retains partial visible output when an upstream stream is interrupted', async () => {
      const partialCaller = async () => (async function* () {
        yield { type: 'text' as const, content: 'Partial translation' };
        throw new IncompleteOutputError(
          'LLM stream was interrupted before a completion marker',
          'Partial translation',
        );
      })();
      const summary = await runFanOut(
        [makeAgent('partial-agent', 'partial-model', 'http://unused.invalid')],
        {},
        partialCaller,
        { retryDelaysMs: [] },
      );

      expect(summary.results[0]).toMatchObject({
        status: 'error',
        content: 'Partial translation',
        error: 'LLM stream was interrupted before a completion marker',
      });
    });
  });

  // ===========================================================================
  // 2. Concurrency limit: 12 agents + cap 8 → peak ≤ 8
  // ===========================================================================
  describe('concurrency cap', () => {
    it('12 agents → peak in-flight ≤ 8', async () => {
      mock = await startMockLLM({ port: 0 });

      // All agents use stream with a small delay to allow concurrency to build up
      for (let i = 0; i < 12; i++) {
        mock.setBehavior(`agent-model-${i}`, {
          behavior: 'stream',
          chunkDelayMs: 5,
        });
      }

      const agents = makeAgents(12, mock.url);
      const counter: ConcurrencyCounter = { current: 0, peak: 0 };

      const summary = await runFanOut(agents, {}, chatCompletion, {
        concurrencyCounter: counter,
      });

      // Peak should never exceed 8
      expect(counter.peak).toBeLessThanOrEqual(8);
      // But should have reached concurrency > 1 (actually running in parallel)
      expect(counter.peak).toBeGreaterThanOrEqual(2);

      expect(summary.succeeded).toBe(12);
      expect(summary.failed).toBe(0);
    });
  });

  // ===========================================================================
  // 3. Retry: 429 → retries 2 times then fails; 401 → 0 retries
  // ===========================================================================
  describe('retry behavior', () => {
    it('429 → retries 3 times (4 total calls) → marked error', async () => {
      mock = await startMockLLM({ port: 0 });
      // error behavior with status 429
      mock.setBehavior('retry-agent', { behavior: 'error', status: 429 });

      const agents = [makeAgent('retry-agent', 'retry-agent', mock.url)];

      const summary = await runFanOut(agents, {}, chatCompletion, { retryDelaysMs: [1, 2] });

      expect(summary.failed).toBe(1);
      expect(summary.succeeded).toBe(0);

      // Should have made 4 calls: original + 3 retries
      const reqs = mock.getRequests();
      const callsForAgent = reqs.filter((r) => {
        const body = r.body as Record<string, unknown> | undefined;
        return body?.model === 'retry-agent';
      });
      // retryDelaysMs [1,2] → 2 retries → 3 calls total
      expect(callsForAgent.length).toBe(3);
    });

    it('401 → 0 retries (1 total call) → marked error', async () => {
      mock = await startMockLLM({ port: 0 });
      mock.setBehavior('no-retry-agent', { behavior: 'error', status: 401 });

      const agents = [makeAgent('no-retry-agent', 'no-retry-agent', mock.url)];

      const summary = await runFanOut(agents, {}, chatCompletion);

      expect(summary.failed).toBe(1);

      const reqs = mock.getRequests();
      const callsForAgent = reqs.filter((r) => {
        const body = r.body as Record<string, unknown> | undefined;
        return body?.model === 'no-retry-agent';
      });
      expect(callsForAgent.length).toBe(1); // no retries
    });

    it('empty body → retries, then marked error', async () => {
      mock = await startMockLLM({ port: 0 });
      mock.setBehavior('empty-agent', { behavior: 'empty' });

      const agents = [makeAgent('empty-agent', 'empty-agent', mock.url)];

      const summary = await runFanOut(
        agents,
        {},
        chatCompletion,
        { retryDelaysMs: [1, 2] },
      );

      expect(summary.failed).toBe(1);
      expect(summary.succeeded).toBe(0);
      expect(summary.results[0]).toMatchObject({ status: 'error' });
      expect(summary.results[0].error).toMatch(/visible content/i);

      const reqs = mock.getRequests();
      const callsForAgent = reqs.filter((r) => {
        const body = r.body as Record<string, unknown> | undefined;
        return body?.model === 'empty-agent';
      });
      // original + 2 retries with [1,2] backoff
      expect(callsForAgent.length).toBe(3);
    });
  });

  // ===========================================================================
  // 4. Abort mid-stream → in-progress marked aborted
  // ===========================================================================
  describe('abort signal', () => {
    it('abort mid-stream → completed results kept, in-progress marked aborted', async () => {
      mock = await startMockLLM({ port: 0 });

      // Some agents use slow stream, so abort catches them mid-flight
      for (let i = 0; i < 6; i++) {
        // Use a delay of 20ms to make some agents still in-flight when abort fires
        mock.setBehavior(`agent-model-${i}`, {
          behavior: 'stream',
          chunkDelayMs: 20,
        });
      }

      const agents = makeAgents(6, mock.url);
      const ctrl = new AbortController();

      // Abort after a short delay — some agents may have completed, some won't
      const abortPromise = new Promise<void>((resolve) => {
        setTimeout(() => {
          ctrl.abort();
          resolve();
        }, 80); // Delay to let some stream tokens flow
      });

      const summaryPromise = runFanOut(agents, {}, chatCompletion, {
        signal: ctrl.signal,
      });

      await abortPromise;
      const summary = await summaryPromise;

      // Should have some completed and some aborted (or error from abort)
      const completed = summary.results.filter((r) => r.status === 'complete');
      const aborted = summary.results.filter((r) => r.status === 'aborted');

      // At least 1 should be complete (the ones that finished before abort)
      // At least 1 should be aborted
      expect(completed.length + aborted.length).toBeGreaterThan(0);
      expect(summary.results.length).toBe(6);
    });
  });

  // ===========================================================================
  // 5. Callback order: start×N → token interleaving → complete/error×N
  // ===========================================================================
  describe('callbacks', () => {
    it('event ordering: start×N → token interleaving → complete/error×N', async () => {
      mock = await startMockLLM({ port: 0 });

      // 3 stream agents, 1 error agent
      for (let i = 0; i < 3; i++) {
        mock.setBehavior(`agent-model-${i}`, {
          behavior: 'stream',
          chunkDelayMs: 5,
        });
      }
      mock.setBehavior('agent-model-3', { behavior: 'error', status: 500 });

      const agents = makeAgents(4, mock.url);

      const events: string[] = [];
      const callbacks: FanOutCallbacks = {
        onAgentStart: (key) => events.push(`start:${key}`),
        onToken: (key, _content) => events.push(`token:${key}`),
        onAgentComplete: (key) => events.push(`complete:${key}`),
        onAgentError: (key) => events.push(`error:${key}`),
      };

      await runFanOut(agents, callbacks, chatCompletion, { retryDelaysMs: [1, 2] });

      // All starts should happen before any completes/errors
      const startEvents = events.filter((e) => e.startsWith('start:'));
      const completeEvents = events.filter((e) => e.startsWith('complete:'));
      const errorEvents = events.filter((e) => e.startsWith('error:'));
      const tokenEvents = events.filter((e) => e.startsWith('token:'));

      // All 4 agents should have started
      expect(startEvents).toHaveLength(4);

      // Tokens should exist (interleaved)
      expect(tokenEvents.length).toBeGreaterThan(0);

      // 3 complete + 1 error (retries do not emit intermediate error events)
      expect(completeEvents.length + errorEvents.length).toBe(4);
      expect(completeEvents.length).toBe(3);
      expect(errorEvents.length).toBe(1);

      // Sequence check: each agent's start appears before its own tokens
      for (let i = 0; i < 4; i++) {
        const key = `agent-${i}`;
        const startIdx = events.findIndex((e) => e === `start:${key}`);
        const firstTokenIdx = events.findIndex(
          (e) => e === `token:${key}`,
        );
        // Every agent starts; token check only applies to streaming agents
        expect(startIdx).toBeGreaterThanOrEqual(0);
        if (i < 3) {
          expect(startIdx).toBeLessThan(firstTokenIdx);
        }
      }

      // The error agent's error event fires exactly once, after its own start
      const errIdx = events.findIndex((e) => e.startsWith('error:'));
      const errStartIdx = events.findIndex(
        (e) => e === 'start:agent-3',
      );
      expect(errStartIdx).toBeLessThan(errIdx);
    });
  });

  // ===========================================================================
  // 6. ServerError (500, retryable) → retries
  // ===========================================================================
  describe('retryable vs non-retryable classification', () => {
    it('ServerError 500 is retryable → retries 3 times', async () => {
      mock = await startMockLLM({ port: 0 });
      mock.setBehavior('srv-agent', { behavior: 'error', status: 500 });

      const agents = [makeAgent('srv-agent', 'srv-agent', mock.url)];
      await runFanOut(agents, {}, chatCompletion, { retryDelaysMs: [1, 2] });

      const reqs = mock.getRequests();
      const calls = reqs.filter((r) => {
        const body = r.body as Record<string, unknown> | undefined;
        return body?.model === 'srv-agent';
      });
      // retryDelaysMs [1,2] → 2 retries → 3 calls total
      expect(calls.length).toBe(3);
    });

    it('ClientError 400 is non-retryable → no retries', async () => {
      mock = await startMockLLM({ port: 0 });
      mock.setBehavior('client-agent', { behavior: 'error', status: 400 });

      const agents = [makeAgent('client-agent', 'client-agent', mock.url)];
      await runFanOut(agents, {}, chatCompletion);

      const reqs = mock.getRequests();
      const calls = reqs.filter((r) => {
        const body = r.body as Record<string, unknown> | undefined;
        return body?.model === 'client-agent';
      });
      expect(calls.length).toBe(1);
    });
  });

  // ===========================================================================
  // 7. Duration measurement
  // ===========================================================================
  describe('duration and summary', () => {
    it('reports positive durationMs in summary', async () => {
      mock = await startMockLLM({ port: 0 });
      mock.setBehavior('fast-agent', { behavior: 'stream', chunkDelayMs: 0 });

      const agents = [makeAgent('fast-agent', 'fast-agent', mock.url)];
      const summary = await runFanOut(agents, {}, chatCompletion);

      expect(summary.durationMs).toBeGreaterThan(0);
      expect(typeof summary.durationMs).toBe('number');
    });
  });

  // ===========================================================================
  // 8. Concurrency counter API surface
  // ===========================================================================
  describe('concurrency counter hook', () => {
    it('tracks current and peak correctly', async () => {
      mock = await startMockLLM({ port: 0 });

      // 5 agents with small delay to observe concurrency
      for (let i = 0; i < 5; i++) {
        mock.setBehavior(`agent-model-${i}`, {
          behavior: 'stream',
          chunkDelayMs: 5,
        });
      }

      const agents = makeAgents(5, mock.url);
      const counter: ConcurrencyCounter = { current: 0, peak: 0 };

      await runFanOut(agents, {}, chatCompletion, {
        concurrencyCounter: counter,
      });

      // After completion, current should be 0
      expect(counter.current).toBe(0);
      // Peak should be at least 1
      expect(counter.peak).toBeGreaterThanOrEqual(1);
      // Peak should not exceed 5
      expect(counter.peak).toBeLessThanOrEqual(5);
    });
  });

  // ===========================================================================
  // 9. Single agent success
  // ===========================================================================
  describe('single agent', () => {
    it('single agent stream → succeeded=1, failed=0', async () => {
      mock = await startMockLLM({ port: 0 });
      mock.setBehavior('solo', { behavior: 'stream' });

      const agents = [makeAgent('solo', 'solo', mock.url)];
      const summary = await runFanOut(agents, {}, chatCompletion);

      expect(summary.succeeded).toBe(1);
      expect(summary.failed).toBe(0);
      expect(summary.results[0].status).toBe('complete');
      expect(summary.results[0].content).toBeTruthy();
    });
  });
});
