/**
 * Agent Orchestration
 * 
 * Implements orchestration patterns for Extension 3.
 * 
 * Supported patterns:
 * - Pipeline: Sequential execution through multiple agents
 * - Parallel: Concurrent execution across multiple agents
 * - Router: Conditional routing to different agents
 */

import type {
  AgentId,
  Pipeline,
  PipelineStep,
  ParallelExecution,
  AgentRouter,
  AgentInvocationRequest,
  AgentInvocationResponse,
  Supervisor,
  SupervisorTask,
  SupervisorResult,
  SupervisorTaskResult,
  SupervisorAssignmentStrategy,
  CreateSupervisorOptions,
} from './types';
import { invokeAgent } from './messaging';
import { getAgent } from './registry';

// =============================================================================
// Pipeline Execution
// =============================================================================

/**
 * Result of a pipeline step
 */
export interface PipelineStepResult {
  stepId: string;
  agentId: AgentId;
  success: boolean;
  result?: unknown;
  error?: string;
  executionTime: number;
}

/**
 * Result of a pipeline execution
 */
export interface PipelineResult {
  pipelineId: string;
  success: boolean;
  stepResults: PipelineStepResult[];
  finalOutput?: unknown;
  totalExecutionTime: number;
  error?: string;
}

/**
 * Execute a pipeline of agent invocations.
 * 
 * Each step's output becomes the next step's input.
 */
export async function executePipeline(
  pipeline: Pipeline,
  initialInput: unknown,
  invokerAgentId: AgentId,
  invokerOrigin: string,
): Promise<PipelineResult> {
  const startTime = Date.now();
  const stepResults: PipelineStepResult[] = [];
  let currentInput = initialInput;

  for (const step of pipeline.steps) {
    const stepStartTime = Date.now();

    // Format the task with the current input
    const task = formatTaskTemplate(step.taskTemplate, currentInput);

    // Create the invocation request
    const request: AgentInvocationRequest = {
      agentId: step.agentId,
      task,
      input: currentInput,
    };

    // Invoke the agent
    const response = await invokeAgent(request, invokerAgentId, invokerOrigin);

    const stepResult: PipelineStepResult = {
      stepId: step.id,
      agentId: step.agentId,
      success: response.success,
      result: response.result,
      error: response.error?.message,
      executionTime: Date.now() - stepStartTime,
    };

    stepResults.push(stepResult);

    if (!response.success) {
      // Pipeline failed at this step
      return {
        pipelineId: pipeline.id,
        success: false,
        stepResults,
        totalExecutionTime: Date.now() - startTime,
        error: `Pipeline failed at step ${step.id}: ${response.error?.message}`,
      };
    }

    // Apply output transform if specified
    if (step.outputTransform) {
      currentInput = applyTransform(response.result, step.outputTransform);
    } else {
      currentInput = response.result;
    }
  }

  return {
    pipelineId: pipeline.id,
    success: true,
    stepResults,
    finalOutput: currentInput,
    totalExecutionTime: Date.now() - startTime,
  };
}

/**
 * Format a task template with input data.
 * Replaces {{input}} with JSON stringified input.
 */
function formatTaskTemplate(template: string, input: unknown): string {
  const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
  return template.replace(/\{\{input\}\}/g, inputStr);
}

/**
 * Apply a simple transform to output.
 * Supports dot notation for object property access.
 */
function applyTransform(value: unknown, transform: string): unknown {
  if (transform.startsWith('.')) {
    // Dot notation property access
    const path = transform.slice(1).split('.');
    let current = value as Record<string, unknown>;
    
    for (const key of path) {
      if (current === null || current === undefined) return undefined;
      current = current[key] as Record<string, unknown>;
    }
    
    return current;
  }
  
  return value;
}

// =============================================================================
// Parallel Execution
// =============================================================================

/**
 * Result of a single parallel task
 */
export interface ParallelTaskResult {
  agentId: AgentId;
  success: boolean;
  result?: unknown;
  error?: string;
  executionTime: number;
}

/**
 * Result of parallel execution
 */
export interface ParallelResult {
  executionId: string;
  success: boolean;
  taskResults: ParallelTaskResult[];
  combinedOutput?: unknown;
  totalExecutionTime: number;
}

/**
 * Execute multiple agent invocations in parallel.
 */
export async function executeParallel(
  execution: ParallelExecution,
  invokerAgentId: AgentId,
  invokerOrigin: string,
): Promise<ParallelResult> {
  const startTime = Date.now();
  const tasks = Array.isArray(execution.tasks) ? execution.tasks : [];

  // Execute all tasks in parallel
  const taskPromises = tasks.map(async (task) => {
    const taskStartTime = Date.now();
    
    const request: AgentInvocationRequest = {
      agentId: task.agentId,
      task: task.task,
      input: task.input,
    };

    const response = await invokeAgent(request, invokerAgentId, invokerOrigin);

    return {
      agentId: task.agentId,
      success: response.success,
      result: response.result,
      error: response.error?.message,
      executionTime: Date.now() - taskStartTime,
    };
  });

  const taskResults = await Promise.all(taskPromises);
  const allSuccess = taskResults.every(r => r.success);

  // Combine results based on strategy
  let combinedOutput: unknown;
  
  switch (execution.combineStrategy) {
    case 'array':
      combinedOutput = taskResults.map(r => r.result);
      break;
    
    case 'merge':
      combinedOutput = taskResults.reduce((acc, r) => {
        if (r.result && typeof r.result === 'object') {
          return { ...acc, ...(r.result as object) };
        }
        return acc;
      }, {});
      break;
    
    case 'first':
      combinedOutput = taskResults.find(r => r.success)?.result;
      break;
    
    case 'custom':
      // Custom strategy returns all results for the caller to handle
      combinedOutput = taskResults;
      break;
  }

  return {
    executionId: execution.id,
    success: allSuccess,
    taskResults,
    combinedOutput,
    totalExecutionTime: Date.now() - startTime,
  };
}

// =============================================================================
// Router
// =============================================================================

/**
 * Result of routing
 */
export interface RouterResult {
  routerId: string;
  selectedAgentId: AgentId;
  matchedCondition: string | null;
  invocationResult: AgentInvocationResponse;
}

/**
 * Route to an agent based on input conditions.
 */
export async function executeRouter(
  router: AgentRouter,
  input: unknown,
  task: string,
  invokerAgentId: AgentId,
  invokerOrigin: string,
): Promise<RouterResult> {
  let selectedAgentId: AgentId | undefined;
  let matchedCondition: string | null = null;

  // Evaluate routes in order
  for (const route of router.routes) {
    if (evaluateCondition(route.condition, input)) {
      selectedAgentId = route.agentId;
      matchedCondition = route.condition;
      break;
    }
  }

  // Fall back to default if no route matched
  if (!selectedAgentId) {
    if (router.defaultAgentId) {
      selectedAgentId = router.defaultAgentId;
    } else {
      return {
        routerId: router.id,
        selectedAgentId: '',
        matchedCondition: null,
        invocationResult: {
          success: false,
          error: { code: 'ERR_NO_ROUTE', message: 'No matching route and no default agent' },
          executionTime: 0,
        },
      };
    }
  }

  // Invoke the selected agent
  const request: AgentInvocationRequest = {
    agentId: selectedAgentId,
    task,
    input,
  };

  const result = await invokeAgent(request, invokerAgentId, invokerOrigin);

  return {
    routerId: router.id,
    selectedAgentId,
    matchedCondition,
    invocationResult: result,
  };
}

/**
 * Evaluate a simple condition against input.
 * 
 * Supports:
 * - Property existence: "hasProperty:fieldName"
 * - Value match: "field:value"
 * - Type check: "type:string", "type:number", "type:object"
 * - Regex match: "regex:pattern"
 */
function evaluateCondition(condition: string, input: unknown): boolean {
  if (condition === 'always') {
    return true;
  }

  const inputObj = input as Record<string, unknown>;

  if (condition.startsWith('hasProperty:')) {
    const prop = condition.slice('hasProperty:'.length);
    return inputObj !== null && typeof inputObj === 'object' && prop in inputObj;
  }

  if (condition.startsWith('type:')) {
    const expectedType = condition.slice('type:'.length);
    return typeof input === expectedType;
  }

  if (condition.startsWith('regex:')) {
    const pattern = condition.slice('regex:'.length);
    try {
      const regex = new RegExp(pattern);
      return typeof input === 'string' && regex.test(input);
    } catch {
      return false;
    }
  }

  // Value match: "field:value"
  const colonIndex = condition.indexOf(':');
  if (colonIndex > 0) {
    const field = condition.slice(0, colonIndex);
    const value = condition.slice(colonIndex + 1);
    
    if (inputObj && typeof inputObj === 'object') {
      return String(inputObj[field]) === value;
    }
  }

  return false;
}

// =============================================================================
// Supervisor Execution
// =============================================================================

/**
 * Track worker state during supervisor execution
 */
interface WorkerState {
  busyCount: number;
  totalAssigned: number;
}

/**
 * Execute tasks using a supervisor pattern with worker pool.
 * 
 * The supervisor distributes tasks to workers based on the assignment strategy,
 * handles retries on failure, and aggregates results.
 */
export async function executeSupervisor(
  supervisor: Supervisor,
  tasks: SupervisorTask[],
  invokerAgentId: AgentId,
  invokerOrigin: string,
): Promise<SupervisorResult> {
  const startTime = Date.now();
  const results: SupervisorTaskResult[] = [];
  const workerState = new Map<AgentId, WorkerState>();
  const maxConcurrent = supervisor.maxConcurrentPerWorker ?? 1;

  // Initialize worker state
  for (const workerId of supervisor.workers) {
    workerState.set(workerId, { busyCount: 0, totalAssigned: 0 });
  }

  // Validate workers exist
  const validWorkers: AgentId[] = [];
  for (const workerId of supervisor.workers) {
    const worker = getAgent(workerId);
    if (worker && worker.acceptsInvocations) {
      validWorkers.push(workerId);
    }
  }

  if (validWorkers.length === 0) {
    return {
      success: false,
      results: tasks.map((task) => ({
        taskId: task.id,
        workerId: '',
        error: 'No valid workers available',
        attempts: 0,
        executionTime: 0,
      })),
      stats: {
        totalTasks: tasks.length,
        succeeded: 0,
        failed: tasks.length,
        totalTime: Date.now() - startTime,
      },
    };
  }

  // Sort tasks by priority (higher priority first)
  const sortedTasks = [...tasks].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  // Round-robin index tracker
  let roundRobinIndex = 0;

  // Execute all tasks
  const taskPromises = sortedTasks.map(async (task) => {
    const taskStartTime = Date.now();
    let attempts = 0;
    let lastError: string | undefined;
    const maxAttempts = (supervisor.retry?.maxAttempts ?? 0) + 1;
    const triedWorkers = new Set<AgentId>();

    while (attempts < maxAttempts) {
      // Select a worker based on strategy
      const worker = selectWorker(
        supervisor.assignmentStrategy,
        validWorkers,
        workerState,
        maxConcurrent,
        task,
        triedWorkers,
        roundRobinIndex,
      );

      if (!worker) {
        lastError = 'No available worker for task';
        break;
      }

      // Update round-robin index for next task
      if (supervisor.assignmentStrategy === 'round-robin') {
        roundRobinIndex = (validWorkers.indexOf(worker) + 1) % validWorkers.length;
      }

      // Mark worker as busy
      const state = workerState.get(worker)!;
      state.busyCount++;
      state.totalAssigned++;
      triedWorkers.add(worker);

      attempts++;

      try {
        // Invoke the worker
        const request: AgentInvocationRequest = {
          agentId: worker,
          task: task.task,
          input: task.input,
        };

        const response = await invokeAgent(request, invokerAgentId, invokerOrigin);

        // Mark worker as not busy
        state.busyCount--;

        if (response.success) {
          return {
            taskId: task.id,
            workerId: worker,
            result: response.result,
            attempts,
            executionTime: Date.now() - taskStartTime,
          };
        } else {
          lastError = response.error?.message ?? 'Unknown error';

          // If reassign on failure is enabled and we have more attempts, try another worker
          if (supervisor.retry?.reassignOnFailure && attempts < maxAttempts) {
            if (supervisor.retry.delayMs) {
              await delay(supervisor.retry.delayMs);
            }
            continue;
          }
        }
      } catch (error) {
        // Mark worker as not busy on error
        state.busyCount--;
        lastError = error instanceof Error ? error.message : 'Unknown error';

        if (attempts < maxAttempts && supervisor.retry?.delayMs) {
          await delay(supervisor.retry.delayMs);
        }
      }
    }

    // All attempts failed
    return {
      taskId: task.id,
      workerId: triedWorkers.size > 0 ? Array.from(triedWorkers).pop()! : '',
      error: lastError,
      attempts,
      executionTime: Date.now() - taskStartTime,
    };
  });

  // Wait for all tasks to complete
  const taskResults = await Promise.all(taskPromises);
  results.push(...taskResults);

  // Aggregate results
  const succeeded = results.filter((r) => !r.error).length;
  const failed = results.filter((r) => r.error).length;

  return {
    success: failed === 0,
    results,
    stats: {
      totalTasks: tasks.length,
      succeeded,
      failed,
      totalTime: Date.now() - startTime,
    },
  };
}

/**
 * Select a worker based on the assignment strategy.
 */
function selectWorker(
  strategy: SupervisorAssignmentStrategy,
  workers: AgentId[],
  workerState: Map<AgentId, WorkerState>,
  maxConcurrent: number,
  task: SupervisorTask,
  excludeWorkers: Set<AgentId>,
  roundRobinIndex: number,
): AgentId | null {
  // Filter out excluded workers and workers at max capacity
  const availableWorkers = workers.filter((w) => {
    if (excludeWorkers.has(w)) return false;
    const state = workerState.get(w);
    return state && state.busyCount < maxConcurrent;
  });

  if (availableWorkers.length === 0) {
    // If all workers are busy, fall back to any non-excluded worker
    const fallbackWorkers = workers.filter((w) => !excludeWorkers.has(w));
    if (fallbackWorkers.length === 0) return null;
    return fallbackWorkers[0];
  }

  switch (strategy) {
    case 'round-robin': {
      // Start from roundRobinIndex and find next available
      for (let i = 0; i < availableWorkers.length; i++) {
        const idx = (roundRobinIndex + i) % workers.length;
        const worker = workers[idx];
        if (availableWorkers.includes(worker)) {
          return worker;
        }
      }
      return availableWorkers[0];
    }

    case 'random': {
      const idx = Math.floor(Math.random() * availableWorkers.length);
      return availableWorkers[idx];
    }

    case 'least-busy': {
      let leastBusy: AgentId | null = null;
      let minBusy = Infinity;

      for (const worker of availableWorkers) {
        const state = workerState.get(worker)!;
        if (state.busyCount < minBusy) {
          minBusy = state.busyCount;
          leastBusy = worker;
        }
      }

      return leastBusy;
    }

    case 'capability-match': {
      if (!task.requiredCapabilities || task.requiredCapabilities.length === 0) {
        // No capabilities required, use round-robin as fallback
        return availableWorkers[0];
      }

      // Find workers with matching capabilities
      for (const worker of availableWorkers) {
        const agent = getAgent(worker);
        if (agent) {
          const hasAllCapabilities = task.requiredCapabilities.every((cap) =>
            agent.capabilities.includes(cap),
          );
          if (hasAllCapabilities) {
            return worker;
          }
        }
      }

      // No worker matches, return first available
      return availableWorkers[0];
    }

    default:
      return availableWorkers[0];
  }
}

/**
 * Delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a simple supervisor configuration.
 */
export function createSupervisor(options: CreateSupervisorOptions): Supervisor {
  return {
    id: `supervisor-${Date.now()}`,
    name: options.name,
    workers: options.workers,
    assignmentStrategy: options.strategy ?? 'round-robin',
    maxConcurrentPerWorker: 1,
    retry: options.maxRetries
      ? {
          maxAttempts: options.maxRetries,
          delayMs: 1000,
          reassignOnFailure: true,
        }
      : undefined,
    aggregation: 'array',
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Create a simple pipeline from agent IDs.
 */
export function createSimplePipeline(
  id: string,
  name: string,
  agentIds: AgentId[],
): Pipeline {
  return {
    id,
    name,
    steps: agentIds.map((agentId, index) => ({
      id: `step-${index}`,
      agentId,
      taskTemplate: '{{input}}',
    })),
  };
}

/**
 * Create a parallel execution from agent IDs with the same task.
 */
export function createBroadcastExecution(
  id: string,
  agentIds: AgentId[],
  task: string,
  input?: unknown,
): ParallelExecution {
  return {
    id,
    tasks: agentIds.map(agentId => ({ agentId, task, input })),
    combineStrategy: 'array',
  };
}
