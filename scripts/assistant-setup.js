#!/usr/bin/env node
// One-time (re-runnable) setup of the Managed Agents resources for "Mac".
//
//   node scripts/assistant-setup.js            → create whatever is missing
//   node scripts/assistant-setup.js --update   → also push a new version of the
//                                                agent (system prompt, tools)
//
// Reads from .env / environment:
//   ANTHROPIC_API_KEY, PUBLIC_API_URL, ASSISTANT_MCP_TOKEN
//   ASSISTANT_ENVIRONMENT_ID, ASSISTANT_MEMORY_STORE_ID, ASSISTANT_VAULT_ID,
//   ASSISTANT_AGENT_ID, ASSISTANT_BRIEF_DEPLOYMENT_ID (optional, reused if set)
// Prints the IDs to copy into Railway's variables.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const client = new (Anthropic.default || Anthropic)();
const PUBLIC_URL = (process.env.PUBLIC_API_URL || 'https://mactor-inspections-api-production.up.railway.app').replace(/\/$/, '');
const MCP_URL = `${PUBLIC_URL}/mcp`;
const SYSTEM = fs.readFileSync(path.join(__dirname, '..', 'assistant', 'system-prompt.md'), 'utf8');
const UPDATE = process.argv.includes('--update');

const AGENT_CONFIG = {
  name: 'Mac — asistente de Julio',
  description: 'Asistente personal por WhatsApp para MacTor Construction y FixMyProperty.',
  model: { id: 'claude-sonnet-5-5', effort: 'medium' },
  system: SYSTEM,
  mcp_servers: [{ type: 'url', name: 'mactor', url: MCP_URL }],
  tools: [
    {
      // Only the file tools (needed for the memory directory) and web search.
      type: 'agent_toolset_20260401',
      default_config: { enabled: false },
      configs: [
        { name: 'read', enabled: true, permission_policy: { type: 'always_allow' } },
        { name: 'write', enabled: true, permission_policy: { type: 'always_allow' } },
        { name: 'edit', enabled: true, permission_policy: { type: 'always_allow' } },
        { name: 'glob', enabled: true, permission_policy: { type: 'always_allow' } },
        { name: 'grep', enabled: true, permission_policy: { type: 'always_allow' } },
        { name: 'web_search', enabled: true, permission_policy: { type: 'always_allow' } },
        { name: 'web_fetch', enabled: false },
        { name: 'bash', enabled: false },
      ],
    },
    // Our own MCP server: every tool is read-only or a propose_* (which only
    // asks Julio), so they run without an extra approval round-trip.
    { type: 'mcp_toolset', mcp_server_name: 'mactor', default_config: { enabled: true, permission_policy: { type: 'always_allow' } } },
  ],
};

async function main() {
  if (!process.env.ASSISTANT_MCP_TOKEN) throw new Error('Set ASSISTANT_MCP_TOKEN first (e.g. `openssl rand -hex 32`)');
  const out = {};

  out.ASSISTANT_ENVIRONMENT_ID = process.env.ASSISTANT_ENVIRONMENT_ID || (await client.beta.environments.create({
    name: 'mac-assistant',
    // Unrestricted so web_search can search any public site (limited networking
    // with no allowed_hosts blocks it). bash and web_fetch stay disabled, so the
    // only web access is search results.
    config: { type: 'cloud', networking: { type: 'unrestricted' } },
  })).id;

  out.ASSISTANT_MEMORY_STORE_ID = process.env.ASSISTANT_MEMORY_STORE_ID || (await client.beta.memoryStores.create({
    name: 'Mac — memoria de Julio',
    description: 'Hechos duraderos sobre Julio, MacTor Construction y FixMyProperty: preferencias, clientes frecuentes, precios habituales, proveedores y pendientes que Julio pidió recordar.',
  })).id;

  if (process.env.ASSISTANT_VAULT_ID) {
    out.ASSISTANT_VAULT_ID = process.env.ASSISTANT_VAULT_ID;
  } else {
    const vault = await client.beta.vaults.create({ display_name: 'mac-assistant' });
    await client.beta.vaults.credentials.create(vault.id, {
      display_name: 'MacTor MCP',
      auth: { type: 'static_bearer', mcp_server_url: MCP_URL, token: process.env.ASSISTANT_MCP_TOKEN },
    });
    out.ASSISTANT_VAULT_ID = vault.id;
  }

  if (process.env.ASSISTANT_AGENT_ID) {
    out.ASSISTANT_AGENT_ID = process.env.ASSISTANT_AGENT_ID;
    if (UPDATE) {
      const current = await client.beta.agents.retrieve(out.ASSISTANT_AGENT_ID);
      const updated = await client.beta.agents.update(out.ASSISTANT_AGENT_ID, { ...AGENT_CONFIG, version: current.version });
      console.log(`Agent updated → version ${updated.version}`);
    }
  } else {
    out.ASSISTANT_AGENT_ID = (await client.beta.agents.create(AGENT_CONFIG)).id;
  }

  out.ASSISTANT_BRIEF_DEPLOYMENT_ID = process.env.ASSISTANT_BRIEF_DEPLOYMENT_ID || (await client.beta.deployments.create({
    name: 'Mac — brief diario 7:00',
    agent: out.ASSISTANT_AGENT_ID,
    environment_id: out.ASSISTANT_ENVIRONMENT_ID,
    vault_ids: [out.ASSISTANT_VAULT_ID],
    resources: [{ type: 'memory_store', memory_store_id: out.ASSISTANT_MEMORY_STORE_ID, access: 'read_write' }],
    initial_events: [{
      type: 'user.message',
      content: [{ type: 'text', text: 'Ejecución programada: prepara el brief diario de hoy siguiendo tus instrucciones y envíalo a Julio con send_whatsapp_to_julio. No esperes respuesta.' }],
    }],
    schedule: { type: 'cron', expression: '0 7 * * *', timezone: 'America/Toronto' },
    budget: { type: 'limit', max_list_cost: { amount: '150', currency: 'USD' } },
  })).id;

  console.log('\nCopy these into Railway → mactor-inspections-api → Variables:\n');
  for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
