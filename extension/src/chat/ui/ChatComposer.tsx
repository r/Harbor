import type { FormEvent } from 'react';

type ChatComposerProps = {
  value: string;
  state: 'blocked' | 'ready' | 'working';
  onChange(value: string): void;
  onSubmit(): void;
};

export function ChatComposer({
  value,
  state,
  onChange,
  onSubmit,
}: ChatComposerProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form className="chat-composer" onSubmit={handleSubmit}>
      <div className="chat-composer__label">
        <label htmlFor="harbor-chat-prompt">Message Harbor</label>
        <span id="harbor-chat-count">
          {value.length.toLocaleString()} characters
        </span>
      </div>
      <div className="chat-composer__control">
        <textarea
          aria-describedby="harbor-chat-count harbor-chat-help"
          disabled={state === 'blocked'}
          id="harbor-chat-prompt"
          onChange={event => onChange(event.target.value)}
          placeholder={state === 'blocked'
            ? 'Finish the route setup to start chatting'
            : 'Describe the outcome you want'}
          rows={4}
          value={value}
        />
        <button
          disabled={!value.trim() || state !== 'ready'}
          type="submit"
        >
          <span>{state === 'working' ? 'Working' : 'Send message'}</span>
          <span aria-hidden="true">↗</span>
        </button>
      </div>
      <p id="harbor-chat-help">
        Access is requested only when you send. Page context and tools default
        to off.
      </p>
    </form>
  );
}
