/**
 * Custom error types for tool execution.
 */

export type ToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'INVALID_ARGUMENTS'
  | 'EXECUTION_FAILED'
  | 'INPUT_TOO_LARGE';

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function invalidArgument(message: string, details?: unknown): ToolError {
  return new ToolError('INVALID_ARGUMENTS', message, details);
}

export function toolNotFound(toolName: string): ToolError {
  return new ToolError('TOOL_NOT_FOUND', `Unknown tool: ${toolName}`);
}

export function executionFailed(message: string, details?: unknown): ToolError {
  return new ToolError('EXECUTION_FAILED', message, details);
}

export function inputTooLarge(size: number, maxSize: number): ToolError {
  return new ToolError(
    'INPUT_TOO_LARGE',
    `Input size (${size} bytes) exceeds maximum (${maxSize} bytes)`
  );
}
