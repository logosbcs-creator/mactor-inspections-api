const OpenAI = require('openai');

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

// Best-effort translation to English for client-facing text Julio may have
// typed in Spanish (task/line-item descriptions) — falls back to the
// original text if OpenAI isn't configured or the call fails, so a
// translation hiccup never blocks a reminder/email from going out.
async function toEnglish(text) {
  if (!text || !text.trim() || !openai) return text;
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: `Translate the following to natural English. If it's already in English, return it unchanged. Return ONLY the translated text, nothing else:\n\n${text}`,
      }],
      temperature: 0,
    });
    return response.choices[0]?.message?.content?.trim() || text;
  } catch (err) {
    console.error('[Translate] Failed, using original text:', err.message);
    return text;
  }
}

module.exports = { toEnglish };
