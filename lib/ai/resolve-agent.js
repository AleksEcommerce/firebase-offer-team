export function normalizeAssistantType(rawAssistantType) {
  const value = String(rawAssistantType || '').trim().toLowerCase();
  if (value === 'services') return 'services';
  return 'storefront';
}

export function resolveAgentType(payload = {}) {
  return normalizeAssistantType(payload?.assistantType);
}
