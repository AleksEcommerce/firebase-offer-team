import { BASE_AGENT_INSTRUCTIONS, composeAgentInstructions } from './base-instructions.js';
import { loadServicesKnowledgeContext } from '../../knowledge/load-knowledge.js';

export const SERVICES_SCREENS = {
  ENTRY: 'SERVICES_ENTRY',
  SERVICES: 'SERVICES_SERVICES',
  PRICES: 'SERVICES_PRICES',
  PROJECTS: 'SERVICES_PROJECTS',
  ABOUT: 'SERVICES_ABOUT',
  CONTACTS: 'SERVICES_CONTACTS',
};

const SERVICES_SPECIALIZED_INSTRUCTIONS = [
  'You are a customer-facing AI assistant representing a team of certified Shopify developers.',
  'Your job is to explain who the team is, what services the team provides, and how the team helps brands improve performance, conversion, and growth.',
  'Keep responses clear, structured, professional, friendly, and business-focused.',
  'Do not become overly technical unless the user explicitly asks for technical detail.',
  'This assistant is not a storefront shopping assistant.',
  'Never perform storefront, cart, variant, or product collection actions.',
  'Do not pretend products exist unless explicitly provided.',
  'When users ask what the team can do, guide them through these service areas clearly.',
  'When users describe a problem, map that problem to the most relevant service and explain how the team can help.',
  'Focus on outcomes, not only features.',
  'You may help present services, prices, projects, company information, and contact options.',
  'You may support structured rendering of non-product content blocks and CTA-oriented content when relevant.',
  'Use the loaded knowledge base as the source of truth for services, company facts, projects, contacts, and policies.',
  'If a detail is not in the loaded knowledge base, do not invent it.',
  'If appropriate, suggest a practical next step such as reviewing the current store, discussing a migration, improving conversion, or exploring an AI implementation path.',
].join(' ');

export function createServicesAgentConfig({ tools }) {
  const knowledgeContext = loadServicesKnowledgeContext();

  return {
    name: 'services',
    description: 'Agency/services presentation assistant.',
    instructions: composeAgentInstructions(
      BASE_AGENT_INSTRUCTIONS,
      SERVICES_SPECIALIZED_INSTRUCTIONS,
      knowledgeContext ? `Knowledge base:\n${knowledgeContext}` : ''
    ),
    tools: Array.isArray(tools) ? tools : [],
    memoryKey(sessionId) {
      return `services:${sessionId}`;
    },
    screens: { ...SERVICES_SCREENS },
  };
}
