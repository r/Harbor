type PortLightProps = {
  state: 'neutral' | 'ready' | 'pending' | 'attention';
};

export function PortLight({ state }: PortLightProps) {
  return (
    <span
      aria-hidden="true"
      className="port-light"
      data-port-light-state={state}
    />
  );
}
