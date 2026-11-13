export type ConfiguredModel = {
  name: string;
  model_id: string;
  is_default: boolean;
  automatic?: boolean;
};

/** Actions for a saved model or a model discovered automatically by the bridge. */
export function configuredModelActions(model: ConfiguredModel): string {
  return `
    <button class="btn btn-ghost btn-sm test-model-btn" data-model="${model.model_id}" title="Test connection">⚡</button>
    ${!model.automatic && !model.is_default ? `<button class="btn btn-ghost btn-sm set-default-model-btn" data-name="${model.name}" title="Set as default">★</button>` : ''}
    ${!model.automatic ? `<button class="btn btn-ghost btn-sm remove-model-btn" data-name="${model.name}" title="Remove">✕</button>` : ''}
  `;
}

/** Discovered models that the user can save as an explicit selection. */
export function modelsAvailableToAdd<T extends { id: string }>(models: T[], configured: ConfiguredModel[]): T[] {
  const configuredIds = new Set(configured.filter(model => !model.automatic).map(model => model.model_id));
  return models.filter(model => !configuredIds.has(model.id));
}
