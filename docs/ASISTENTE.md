# Asistente "Mac": puesta en marcha

Mac es el asistente personal de Julio por WhatsApp. Lee los correos y los datos del Inspector, avisa de lo urgente y manda un brief diario. Antes de ejecutar cualquier acción con efecto, espera el **"sí N"** de Julio.

```
WhatsApp ─► Twilio ─► POST /api/assistant/whatsapp ─► Claude Managed Agent (claude-opus-5-5)
                                                           │ herramientas MCP
                                                           ▼
                                             POST /mcp (esta misma API) ─► Prisma · Gmail · Zoho
Cron Anthropic 7:00 ─► brief diario     node-cron cada 15 min ─► alertas de correo (claude-haiku-5-5)
```

## Archivos

| Archivo | Qué hace |
|---|---|
| `src/assistant/routes.js` | Webhook de WhatsApp (firma Twilio + whitelist), OAuth de Gmail/Zoho y API del panel |
| `src/assistant/agent.js` | Sesiones del Managed Agent (una por día) y reenvío de respuestas a WhatsApp |
| `src/assistant/mcp.js` | MCP server con todas las herramientas del agente |
| `src/assistant/actions.js` | Propuestas: confirmación con "sí N" y ejecución en código |
| `src/assistant/alerts.js` | Alertas de correo urgente y de inspecciones nuevas |
| `src/assistant/connectors/*` | Gmail, Zoho y el almacén de tokens cifrados |
| `assistant/system-prompt.md` | Personalidad y reglas del agente |
| `scripts/assistant-setup.js` | Crea el agente, el environment, el vault, la memoria y el brief diario |
| `web/app/invoices/asistente` | Panel: conectar correos, aprobar o cancelar acciones y ver la actividad |

## Pasos (una sola vez)

### 1. Base de datos
Agrega 4 tablas nuevas (`AssistantAction`, `AssistantConnection`, `AssistantEvent`, `AssistantState`). No toca las tablas existentes.
```
npx prisma db push
```

### 2. Secretos
Genera dos valores aleatorios y guárdalos en Railway → Variables:
```
node -e "console.log('ASSISTANT_MCP_TOKEN=' + require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log('ASSISTANT_ENC_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```
En Railway agrega también `PUBLIC_API_URL=https://mactor-inspections-api-production.up.railway.app`.

### 3. Anthropic (platform.claude.com)
- Recarga el saldo y activa el auto-reload.
- Pon un **monthly limit** de ~US$30.
- Cada sesión diaria tiene además un tope de US$3 (`ASSISTANT_SESSION_BUDGET_CENTS=300`) y el brief diario uno de US$1.50.

### 4. Twilio: WhatsApp
1. Ve a Console → Messaging → Senders → WhatsApp senders → *Create* y usa el número Twilio actual.
   - Pide conectar o crear el Meta Business Manager y aprobar el display name (p.ej. "MacTor Construction").
   - El número **no** puede estar registrado en la app de WhatsApp normal.
2. En el sender, configura **Webhook URL for incoming messages** = `https://mactor-inspections-api-production.up.railway.app/api/assistant/whatsapp` (POST).
3. En Content Template Builder, crea el template `mac_aviso` (categoría *Utility*, idioma español, tipo Text) con el texto `Hola Julio, tienes un aviso de tu asistente Mac: {{1}}. Responde a este mensaje para continuar.` (WhatsApp no acepta plantillas que empiecen o terminen en variable). Copia el `HX…` cuando lo aprueben.
4. Variables de Railway:
   - `TWILIO_WHATSAPP_FROM=whatsapp:+1XXXXXXXXXX`
   - `TWILIO_WA_TEMPLATE_SID=HX…`
   - Opcional: `ASSISTANT_OWNER_PHONE` (por defecto, el celular de Julio).

Para probar antes de la aprobación existe el *WhatsApp Sandbox* de Twilio: apunta su webhook a la misma URL.

### 5. Crear el agente
Con `ANTHROPIC_API_KEY`, `ASSISTANT_MCP_TOKEN` y `PUBLIC_API_URL` en el `.env` local:
```
node scripts/assistant-setup.js
```
Copia los IDs que imprime (`ASSISTANT_AGENT_ID`, `ASSISTANT_ENVIRONMENT_ID`, `ASSISTANT_VAULT_ID`, `ASSISTANT_MEMORY_STORE_ID`, `ASSISTANT_BRIEF_DEPLOYMENT_ID`) a Railway.

Si después cambias `assistant/system-prompt.md`, sube una nueva versión con:
```
node scripts/assistant-setup.js --update
```

### 6. Gmail (2 cuentas)
1. En Google Cloud Console crea un proyecto "MacTor Asistente" y habilita la **Gmail API**.
2. En OAuth consent screen elige External y **Publish app**. En modo *Testing* los tokens caducan a los 7 días. Para uso propio no hace falta verificación: solo aceptas la advertencia "app no verificada".
3. En Credentials, crea un OAuth client ID de tipo *Web application*, con redirect URI `https://mactor-inspections-api-production.up.railway.app/api/assistant/oauth/google/callback`.
4. Agrega en Railway `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
5. Entra a inspector.fixmyproperty.ca → Configuración → Asistente Mac → **Conectar** en cada Gmail. Inicia sesión con la cuenta que corresponda.

### 7. Zoho Mail
1. En https://api-console.zohocloud.ca crea un *Server-based Application* con redirect URI `https://mactor-inspections-api-production.up.railway.app/api/assistant/oauth/zoho/callback`.
2. Agrega en Railway `ZOHO_CLIENT_ID` y `ZOHO_CLIENT_SECRET`.
3. En el panel, haz clic en **Conectar** junto a Zoho.

### 8. Deploy
Haz merge de la rama `feature/asistente-mac` a `master` en los dos repos (api → Railway, web → Vercel).

## Uso por WhatsApp
- "¿qué tengo hoy?", "¿quién me debe?", "¿qué correos importantes tengo?", "resúmeme el correo de X"
- "mándale recordatorio de pago a Juan" → llega la *Acción #N* → contesta **sí N** o **no N**
- "agéndame mañana 9am con la Sra. López, revisar gotera" → propuesta de tarea en la Agenda
- Notas de voz (se transcriben) y fotos (Mac las ve)
- **pausa** / **reanuda**: apaga o enciende alertas y brief

## Seguridad
- Solo se acepta el número de Julio, y solo con la firma válida de Twilio. Todo lo demás se ignora o recibe 403.
- El agente no tiene ninguna herramienta que ejecute acciones. Solo puede *proponer*. La ejecución ocurre en `actions.js` cuando Julio responde "sí", con un vencimiento de 30 minutos.
- Correos y mensajes de terceros se tratan como datos y nunca como instrucciones. Una inyección en un correo, en el peor caso, produce una propuesta que Julio ve y rechaza.
- Los refresh tokens se guardan cifrados con AES-256-GCM (`ASSISTANT_ENC_KEY`). El token del MCP vive en un vault de Anthropic, no en el prompt.
- `/api/sms/incoming` ahora también valida la firma de Twilio.

## Pendiente (fases siguientes)
- Redes sociales (Facebook/Instagram vía Meta Graph API): DMs, comentarios e insights.
- Más acciones: marcar trabajo hecho en la agenda, convertir tarea → estimado, aprobar inspección.
