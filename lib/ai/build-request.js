import { resolveAgentType } from './resolve-agent.js';
import { buildAgentSessionKey } from './session-key.js';

export function buildAgentRequestContext({
  payload,
  registry,
  language,
  history,
  clientState,
}) {
  const assistantType = resolveAgentType(payload);
  const agentConfig = registry?.[assistantType] || registry?.storefront || null;
  const sessionId = String(payload?.sessionId || payload?.session_id || 'anonymous').trim() || 'anonymous';
  const sessionKey = buildAgentSessionKey(agentConfig, sessionId);

  return {
    assistantType,
    agentConfig,
    sessionId,
    sessionKey,
    language,
    historyCount: Array.isArray(history) ? history.length : 0,
    clientState,
    tools: Array.isArray(agentConfig?.tools) ? agentConfig.tools : [],
    instructions: String(agentConfig?.instructions || '').trim(),
  };
}
