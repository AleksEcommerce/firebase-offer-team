export function buildAgentSessionKey(agentConfig, sessionId) {
  const safeSessionId = String(sessionId || 'anonymous').trim() || 'anonymous';
  if (agentConfig && typeof agentConfig.memoryKey === 'function') {
    return agentConfig.memoryKey(safeSessionId);
  }
  return `storefront:${safeSessionId}`;
}
