/** Wire the safe providers together. Nothing else in the app constructs a
 *  provider directly - going through the registry is what keeps a
 *  credential-taking or process-reading source from ever reaching the UI. */

import { join } from "node:path";
import { ProviderRegistry } from "./provider";
import { createJsonImportProvider } from "./providers/jsonImport";
import { createEeLogProvider } from "./providers/eeLog";
import { createPublicWebProvider, type EndpointsFile } from "./providers/publicWeb";

export * from "./snapshot";
export * from "./provider";

export interface BuildRegistryOptions {
  dataDir: string;
  endpoints: EndpointsFile;
}

export function buildRegistry(options: BuildRegistryOptions): ProviderRegistry {
  const registry = new ProviderRegistry();
  registry.register(createJsonImportProvider());
  registry.register(createPublicWebProvider({ endpoints: options.endpoints }));
  registry.register(createEeLogProvider({ rulesPath: join(options.dataDir, "ee-log-rules.json") }));
  return registry;
}
