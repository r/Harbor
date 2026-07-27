import { PortLight } from './PortLight';

type HarborHeaderProps = {
  state: 'checking' | 'blocked' | 'ready';
};

export function HarborHeader({ state }: HarborHeaderProps) {
  const status = getHeaderStatus(state);

  return (
    <header className="harbor-header">
      <div className="harbor-header__identity">
        <img
          alt=""
          className="harbor-header__mark"
          height="36"
          src="./assets/harbor-mark.svg"
          width="36"
        />
        <div>
          <p className="harbor-header__register">
            Port Authority <span aria-hidden="true">/</span> Chat
          </p>
          <h1>Harbor</h1>
        </div>
      </div>

      <div className="harbor-header__status" data-header-state={state}>
        <PortLight state={status.light} />
        <span>{status.label}</span>
      </div>
    </header>
  );
}

function getHeaderStatus(
  state: HarborHeaderProps['state'],
): {
  label: string;
  light: 'ready' | 'pending' | 'attention';
} {
  if (state === 'ready') {
    return {
      label: 'Ready for departure',
      light: 'ready',
    };
  }
  if (state === 'checking') {
    return {
      label: 'Checking route',
      light: 'pending',
    };
  }
  return {
    label: 'Route needs attention',
    light: 'attention',
  };
}
