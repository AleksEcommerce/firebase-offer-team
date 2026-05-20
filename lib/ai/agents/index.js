import { createServicesAgentConfig } from './services.js';
import { createStorefrontAgentConfig } from './storefront.js';

export function createAgentRegistry({
  storefrontInstructions,
  storefrontTools,
  servicesTools,
}) {
  return {
    storefront: createStorefrontAgentConfig({
      instructions: storefrontInstructions,
      tools: storefrontTools,
    }),
    services: createServicesAgentConfig({
      tools: servicesTools,
    }),
  };
}
