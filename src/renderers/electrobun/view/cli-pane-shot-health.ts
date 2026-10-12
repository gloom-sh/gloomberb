import {
  connectionHealth,
  type ConnectionHealthRegistry,
  registerGloomCloudConnectionSources,
} from "../../../core/connection-health";

/**
 * The capture's own connection health: the registry the page's API client
 * reports to, with the Gloom Cloud sources listed. A `shot CONN` shows the
 * requests this capture made, and idle sources as idle, never a sample.
 */
export function createCliPaneShotConnectionHealth(): ConnectionHealthRegistry {
  registerGloomCloudConnectionSources(connectionHealth);
  return connectionHealth;
}
