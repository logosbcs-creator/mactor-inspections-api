// Talks to the Claude Managed Agent ("Mac"). One session per Toronto day keeps
// the conversation context for the day; long-term facts live in the memory
// store, which every session mounts. The agent, environment, vault and memory
// store are created once by scripts/assistant-setup.js.
const Anthropic = require('@anthropic-ai/sdk');
const prisma = require('../services/database');
const cfg = require('./config');
const { ymd } = require('./business');
const { sendToOwner } = require('./whatsapp');

const client = new (Anthropic.default || Anthropic)();
const TURN_TIMEOUT_MS = 4 * 60 * 1000;

async function state() {
  return prisma.assistantState.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

async function createSession(day) {
  const session = await client.beta.sessions.create({
    agent: cfg.agentId,
    environment_id: cfg.environmentId,
    title: `Mac · ${day}`,
    vault_ids: cfg.vaultId ? [cfg.vaultId] : undefined,
    resources: cfg.memoryStoreId ? [{
      type: 'memory_store', memory_store_id: cfg.memoryStoreId, access: 'read_write',
      instructions: 'Memoria de largo plazo sobre Julio y sus negocios (preferencias, clientes, pendientes). Revísala al empezar y actualízala cuando aprendas algo duradero.',
    }] : undefined,
    budget: { type: 'limit', max_list_cost: { amount: String(cfg.sessionBudgetCents), currency: 'USD' } },
  });
  await prisma.assistantState.update({ where: { id: 1 }, data: { currentSessionId: session.id, sessionDay: day } });
  return session.id;
}

async function currentSession() {
  const st = await state();
  const day = ymd(new Date());
  if (st.currentSessionId && st.sessionDay === day) {
    try {
      const s = await client.beta.sessions.retrieve(st.currentSessionId);
      if (s.status !== 'terminated') return s.id;
    } catch { /* fall through and start a new one */ }
  }
  return createSession(day);
}

// Sends one user turn and resolves with the agent's text replies for it.
async function runTurn(sessionId, content) {
  const stream = await client.beta.sessions.events.stream(sessionId);
  const texts = [];
  let timer;
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), TURN_TIMEOUT_MS);
    (async () => {
      let started = false; // ignore an idle event that predates our message
      for await (const event of stream) {
        if (event.type === 'session.status_running' || (event.type === 'user.message' && event.processed_at)) started = true;
        if (event.type === 'agent.message') {
          for (const b of event.content || []) if (b.type === 'text' && b.text.trim()) texts.push(b.text.trim());
        } else if ((event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') && event.evaluated_permission === 'ask') {
          // Our own tools are always_allow; anything else that pauses is denied —
          // nobody is watching the sandbox, and real actions go through propose_*.
          await client.beta.sessions.events.send(sessionId, { events: [{
            type: 'user.tool_confirmation', tool_use_id: event.id, result: 'deny',
            deny_message: 'No permitido en este entorno. Para acciones usa las herramientas propose_*.',
          }] });
        } else if (event.type === 'session.error') {
          console.error('[Assistant] session.error:', JSON.stringify(event).slice(0, 500));
        } else if (event.type === 'session.status_idle') {
          if (!started || event.stop_reason?.type === 'requires_action') continue;
          return resolve({ texts, stop: event.stop_reason?.type });
        } else if (event.type === 'session.status_terminated') {
          return resolve({ texts, stop: 'terminated' });
        }
      }
      resolve({ texts, stop: 'stream_closed' });
    })().catch(reject);
  });
  await client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.message', content }] });
  try { return await done; }
  finally { clearTimeout(timer); stream.controller?.abort?.(); }
}

// Messages from Julio are handled one at a time so replies never interleave.
let queue = Promise.resolve();
const notes = [];

// Confirmations ("sí 9") are handled in code and never reach the model;
// this tells Mac about them on its next turn so it doesn't contradict them.
function noteForAgent(text) {
  notes.push(text);
  if (notes.length > 10) notes.shift();
}

function handleOwnerMessage(content) {
  queue = queue.then(() => processOwnerMessage(content)).catch(err => console.error('[Assistant] turn failed:', err.message));
  return queue;
}

async function processOwnerMessage(content) {
  if (!cfg.enabled()) {
    await sendToOwner('El asistente aún no está configurado (faltan ASSISTANT_AGENT_ID / ENVIRONMENT_ID / MCP_TOKEN).', { kind: 'system' });
    return;
  }
  const stamp = new Date().toLocaleString('es-CA', { timeZone: cfg.tz, dateStyle: 'medium', timeStyle: 'short' });
  const pre = notes.splice(0).map(n => ({ type: 'text', text: `(Sistema: ${n})` }));
  const blocks = [{ type: 'text', text: `[${stamp}, Toronto]` }, ...pre, ...content];

  let sessionId = await currentSession();
  let result;
  try {
    result = await runTurn(sessionId, blocks);
  } catch (err) {
    if (err.message === 'timeout') {
      await sendToOwner('Sigo trabajando en eso, tardó más de lo normal. Te escribo en cuanto termine o pregúntame de nuevo en un momento.', { kind: 'system', sessionId });
      return;
    }
    // Session unusable (budget, archived…): start fresh once.
    console.error('[Assistant] turn error, starting a new session:', err.message);
    sessionId = await createSession(ymd(new Date()));
    result = await runTurn(sessionId, blocks);
  }

  if (result.stop === 'budget_reached') {
    await sendToOwner('⚠️ Llegué al límite de gasto de hoy para el asistente. Súbelo en Railway (ASSISTANT_SESSION_BUDGET_CENTS) o seguimos mañana.', { kind: 'system', sessionId });
    await prisma.assistantState.update({ where: { id: 1 }, data: { currentSessionId: null } });
    return;
  }
  const reply = result.texts.join('\n\n');
  if (reply) await sendToOwner(reply, { kind: 'out', sessionId });
}

module.exports = { handleOwnerMessage, noteForAgent, client };
