/**
 * Time tools implementation.
 */

import { invalidArgument } from '../errors';

// =============================================================================
// Tool Definitions
// =============================================================================

export const TIME_NOW_DEFINITION = {
  name: 'time.now',
  title: 'Current Time',
  description: 'Returns the current time in human-readable format with timezone support.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      timezone: {
        type: 'string' as const,
        description: 'IANA timezone (e.g., "America/New_York", "Europe/London"). Defaults to local timezone.',
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      formatted: { type: 'string' as const, description: 'Human-readable date and time' },
      date: { type: 'string' as const, description: 'Date in YYYY-MM-DD format' },
      time: { type: 'string' as const, description: 'Time in HH:MM:SS format' },
      dayOfWeek: { type: 'string' as const, description: 'Day of the week' },
      timezone: { type: 'string' as const, description: 'Timezone used' },
      iso: { type: 'string' as const, description: 'ISO 8601 formatted timestamp' },
      epochMs: { type: 'number' as const, description: 'Unix epoch in milliseconds' },
    },
    required: ['formatted', 'date', 'time', 'dayOfWeek', 'timezone', 'iso', 'epochMs'],
  },
};

export const TIME_FORMAT_DEFINITION = {
  name: 'time.format',
  title: 'Format Time',
  description: 'Formats an epoch timestamp to ISO and locale string.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      epochMs: {
        type: 'number' as const,
        description: 'Unix epoch in milliseconds',
      },
      timeZone: {
        type: 'string' as const,
        description: 'IANA time zone (e.g., "America/New_York"). Defaults to "UTC".',
      },
      locale: {
        type: 'string' as const,
        description: 'BCP 47 locale (e.g., "en-US"). Defaults to "en-US".',
      },
    },
    required: ['epochMs'],
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      iso: { type: 'string' as const, description: 'ISO 8601 formatted timestamp' },
      localeString: { type: 'string' as const, description: 'Locale-formatted date/time string' },
    },
    required: ['iso', 'localeString'],
  },
};

// =============================================================================
// Tool Implementations
// =============================================================================

export interface TimeNowInput {
  timezone?: string;
}

export interface TimeNowResult {
  formatted: string;
  date: string;
  time: string;
  dayOfWeek: string;
  timezone: string;
  iso: string;
  epochMs: number;
}

/**
 * Get the current time in a human-readable format.
 */
export function timeNow(input?: TimeNowInput): TimeNowResult {
  const now = new Date();
  const epochMs = now.getTime();

  // Get timezone - try to detect local timezone if not provided
  let timezone = input?.timezone;
  if (!timezone) {
    try {
      timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      timezone = 'UTC';
    }
  }

  // Format with the specified timezone
  try {
    const dateFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const timeFormatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });

    const dayFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
    });

    const fullFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    });

    return {
      formatted: fullFormatter.format(now),
      date: dateFormatter.format(now),
      time: timeFormatter.format(now),
      dayOfWeek: dayFormatter.format(now),
      timezone,
      iso: now.toISOString(),
      epochMs,
    };
  } catch (err) {
    throw invalidArgument(
      `Invalid timezone: ${err instanceof Error ? err.message : String(err)}`,
      { timezone }
    );
  }
}

export interface TimeFormatInput {
  epochMs: number;
  timeZone?: string;
  locale?: string;
}

export interface TimeFormatResult {
  iso: string;
  localeString: string;
}

/**
 * Format an epoch timestamp.
 */
export function timeFormat(input: TimeFormatInput): TimeFormatResult {
  const { epochMs, timeZone = 'UTC', locale = 'en-US' } = input;

  // Validate epochMs
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    throw invalidArgument('epochMs must be a finite number', { epochMs });
  }

  const date = new Date(epochMs);

  // Check for invalid date
  if (isNaN(date.getTime())) {
    throw invalidArgument('Invalid epochMs value', { epochMs });
  }

  let localeString: string;
  try {
    const formatter = new Intl.DateTimeFormat(locale, {
      timeZone,
      dateStyle: 'full',
      timeStyle: 'long',
    });
    localeString = formatter.format(date);
  } catch (err) {
    throw invalidArgument(
      `Invalid timeZone or locale: ${err instanceof Error ? err.message : String(err)}`,
      { timeZone, locale }
    );
  }

  return {
    iso: date.toISOString(),
    localeString,
  };
}
