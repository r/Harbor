import type {
  ChatRunError,
  ChatRunErrorCategory,
  RecoveryAction,
} from '../../contracts';

type ExternalErrorShape = {
  code?: unknown;
  message?: unknown;
  name?: unknown;
};

const CATEGORY_MESSAGES: Record<ChatRunErrorCategory, string> = {
  permission: 'Harbor did not approve this request.',
  model: 'The model could not complete this request.',
  tool: 'A tool could not complete this request.',
  transport: 'Harbor lost connection while running this request.',
  configuration: 'A model needs to be configured before chatting.',
  protocol: 'Harbor received an unexpected response.',
  cancelled: 'This request was cancelled.',
  unknown: 'Harbor could not complete this request.',
};

function getExternalErrorShape(error: unknown): ExternalErrorShape {
  if (typeof error === 'string') {
    return { message: error };
  }

  if (!error || typeof error !== 'object') {
    return {};
  }

  const possibleError = error as ExternalErrorShape;
  return {
    code: possibleError.code,
    message: possibleError.message,
    name: possibleError.name,
  };
}

function inferCategory(code: string, message: string, name: string): ChatRunErrorCategory {
  const searchableError = `${code} ${message} ${name}`.toLowerCase();

  if (searchableError.includes('abort') || searchableError.includes('cancel')) {
    return 'cancelled';
  }
  if (
    searchableError.includes('permission')
    || searchableError.includes('scope')
    || searchableError.includes('policy')
    || searchableError.includes('quarantin')
    || searchableError.includes('user_gesture')
  ) {
    return 'permission';
  }
  if (
    searchableError.includes('no_model')
    || searchableError.includes('not_configured')
    || searchableError.includes('unconfigured')
  ) {
    return 'configuration';
  }
  if (searchableError.includes('tool')) {
    return 'tool';
  }
  if (
    searchableError.includes('network')
    || searchableError.includes('fetch')
    || searchableError.includes('timeout')
    || searchableError.includes('bridge')
    || searchableError.includes('not_installed')
    || searchableError.includes('harbor_not_found')
  ) {
    return 'transport';
  }
  if (searchableError.includes('model') || searchableError.includes('llm')) {
    return 'model';
  }
  if (
    searchableError.includes('protocol')
    || searchableError.includes('empty_response')
    || searchableError.includes('unexpected response')
  ) {
    return 'protocol';
  }

  return 'unknown';
}

function recoveryForCategory(category: ChatRunErrorCategory): RecoveryAction | undefined {
  if (category === 'configuration') {
    return { kind: 'open-connections', label: 'Configure a model' };
  }
  if (category === 'transport' || category === 'model' || category === 'protocol') {
    return { kind: 'retry', label: 'Try again' };
  }
  return undefined;
}

export function normalizeRunError(error: unknown): ChatRunError {
  const externalError = getExternalErrorShape(error);
  const code = typeof externalError.code === 'string'
    ? externalError.code.slice(0, 100)
    : undefined;
  const externalMessage = typeof externalError.message === 'string'
    ? externalError.message
    : '';
  const name = typeof externalError.name === 'string' ? externalError.name : '';
  const category = inferCategory(code ?? '', externalMessage, name);

  return {
    category,
    code,
    message: CATEGORY_MESSAGES[category],
    recovery: recoveryForCategory(category),
  };
}

export function protocolRunError(code: string): ChatRunError {
  return {
    category: 'protocol',
    code,
    message: CATEGORY_MESSAGES.protocol,
    recovery: recoveryForCategory('protocol'),
  };
}

export function cancelledRunError(): ChatRunError {
  return {
    category: 'cancelled',
    code: 'ERR_CANCELLED',
    message: CATEGORY_MESSAGES.cancelled,
  };
}
