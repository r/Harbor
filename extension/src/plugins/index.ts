/**
 * Harbor Plugin System
 *
 * Extension-based plugins that provide tools to Harbor.
 * Plugins register via extension-to-extension messaging and expose
 * their tools through the window.agent API.
 */

// Types
export * from './types';

// Registry
export {
  loadRegistry,
  isPluginAllowed,
  getPluginAllowlist,
  setPluginAllowlist,
  addToAllowlist,
  removeFromAllowlist,
  registerPlugin,
  unregisterPlugin,
  getPlugin,
  getAllPlugins,
  getActivePlugins,
  isPluginRegistered,
  updatePluginStatus,
  recordPluginActivity,
  recordFailedPing,
  enablePlugin,
  disablePlugin,
  updatePluginTools,
  getAggregatedPluginTools,
  findToolPlugin,
  getRegistryStats,
  cleanupStalePlugins,
} from './registry';

// Router
export {
  initializePluginRouter,
  shutdownPluginRouter,
  getRouterStatus,
  callPluginTool,
  pingPlugin,
  requestPluginTools,
  notifyPluginDisabled,
  notifyPluginEnabled,
  startHeartbeat,
  stopHeartbeat,
} from './router';

// Consent
export {
  hasPluginToolPermission,
  hasAnyPluginPermission,
  getAllowedPluginTools,
  getPluginConsentStatus,
  grantPluginPermission,
  revokePluginPermissions,
  clearPluginTabGrants,
  checkPluginConsent,
  getPluginToolsForConsent,
  getAllPluginPermissions,
} from './consent';
