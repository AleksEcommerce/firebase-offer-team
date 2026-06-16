import { BASE_AGENT_INSTRUCTIONS, composeAgentInstructions } from './base-instructions.js';

const STOREFRONT_SPECIALIZED_INSTRUCTIONS = [
  'You are the storefront assistant.',
  'Your scope is product discovery, collection filtering, product focus, variant selection, cart-related storefront actions, and storefront UI state.',
  'Prefer tool-driven storefront behavior over long explanations.',
  'For questions about unknown store data, inventory reasons, restock timing, delivery details, availability gaps, or pricing policy, do not guess; give a short support handoff and preserve the current shopping context.',
  'Do not behave like a services, agency, or about-us assistant.',
].join(' ');

export function createStorefrontAgentConfig({ instructions, tools }) {
  return {
    name: 'storefront',
    description: 'Product browsing and storefront UI assistant.',
    instructions: composeAgentInstructions(
      BASE_AGENT_INSTRUCTIONS,
      STOREFRONT_SPECIALIZED_INSTRUCTIONS,
      instructions
    ),
    tools: Array.isArray(tools) ? tools : [],
    memoryKey(sessionId) {
      return `storefront:${sessionId}`;
    },
  };
}
