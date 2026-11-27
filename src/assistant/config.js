// Central config for the personal assistant ("Mac"). Everything comes from
// env vars so nothing secret lives in code. See docs/ASISTENTE.md.
const { toE164 } = require('../services/sms');

const cfg = {
  // Only this WhatsApp number may talk to the assistant.
  ownerPhone: toE164(process.env.ASSISTANT_OWNER_PHONE || '6475173343'),
  tz: 'America/Toronto',

  // Public base URL of this API as Twilio / Anthropic see it (no trailing slash).
  publicUrl: (process.env.PUBLIC_API_URL || 'https://mactor-inspections-api-production.up.railway.app').replace(/\/$/, ''),

  // Twilio WhatsApp sender, e.g. "whatsapp:+14165550000". Falls back to the
  // shared Messaging Service when the WhatsApp sender is attached to it.
  waFrom: process.env.TWILIO_WHATSAPP_FROM || '',
  // Approved template used outside WhatsApp's 24h window. One variable {{1}}.
  waTemplateSid: process.env.TWILIO_WA_TEMPLATE_SID || '',
  // Approved templates for a FIRST WhatsApp to a third party ({{1}} name, {{2}} message).
  waContactTemplateEs: process.env.TWILIO_WA_CONTACT_TEMPLATE_ES || '',
  waContactTemplateEn: process.env.TWILIO_WA_CONTACT_TEMPLATE_EN || '',

  // Bearer token Anthropic's MCP proxy sends to /mcp (stored in a vault).
  // (Whitespace stripped: pasting into a dashboard can add spaces/newlines,
  // and these hex values never contain any.)
  mcpToken: (process.env.ASSISTANT_MCP_TOKEN || '').replace(/\s+/g, ''),
  // 32-byte key (64 hex chars) for encrypting OAuth refresh tokens.
  encKey: (process.env.ASSISTANT_ENC_KEY || '').replace(/\s+/g, ''),

  // Managed Agents resources, created once by scripts/assistant-setup.js.
  agentId: process.env.ASSISTANT_AGENT_ID || '',
  environmentId: process.env.ASSISTANT_ENVIRONMENT_ID || '',
  vaultId: process.env.ASSISTANT_VAULT_ID || '',
  memoryStoreId: process.env.ASSISTANT_MEMORY_STORE_ID || '',
  // Hard cap per daily session, in US cents (default $3).
  sessionBudgetCents: process.env.ASSISTANT_SESSION_BUDGET_CENTS || '300',

  // How long a proposed action can be confirmed.
  actionTtlMinutes: 30,
};

cfg.enabled = () => !!(cfg.agentId && cfg.environmentId && cfg.mcpToken);

module.exports = cfg;
