/**
 * The text on an agent-question button. Agents name their options, and Harbor
 * shows those names as written, with one exception: an agent that names an
 * option with its bare code (goose sends `name: "allow_always"`) gets that code
 * shown in sentence case ("Allow always"). The option the agent receives back
 * is unchanged either way; only the button text differs.
 */
export interface LabelledOption {
  optionId: string;
  name: string;
  kind: string;
}

const SNAKE_CODE = /^[a-z]+(?:_[a-z]+)+$/;

export function optionLabel(option: LabelledOption): string {
  const { name } = option;
  const isCode = SNAKE_CODE.test(name) && (name === option.kind || name === option.optionId);
  if (!isCode) return name;
  const words = name.split('_').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
