// OpenRouter: the free backup when Gemini's limits are used up. It speaks the OpenAI chat format,
// so this file translates the conversation into that format and turns the replies back into
// Gemini-shaped chunks, letting the rest of the app treat every model the same way.
import { sseEvents } from './sse.js';

const BASE = 'https://openrouter.ai/api/v1';

export async function checkKey(key) {
  const res = await fetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw await apiError(res);
  return (await res.json()).data || {};
}

// `models` is tried in order by OpenRouter itself when one is busy or unavailable.
export async function* stream({ key, models, system, contents, tools, signal }) {
  const list = models.filter(Boolean);
  const body = {
    ...(list.length > 1 ? { models: list } : { model: list[0] }),
    messages: toMessages(system, contents),
    tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toJsonSchema(t.parameters) } })),
    stream: true,
  };
  const calls = [];   // tool calls arrive in pieces, by index
  let finish = '';
  let usage = null;
  let model = '';
  for await (const ev of sseEvents({
    url: `${BASE}/chat/completions`,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body,
    signal,
    toError: apiError,
    source: 'OpenRouter',
  })) {
    if (ev.error) throw streamError(ev.error);
    model = ev.model || model;
    if (ev.usage) usage = ev.usage;
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    const parts = [];
    if (delta.reasoning) parts.push({ text: delta.reasoning, thought: true });
    if (delta.content) parts.push({ text: delta.content });
    for (const tc of delta.tool_calls || []) {
      const c = (calls[tc.index ?? calls.length] ??= { id: '', name: '', args: '' });
      if (tc.id) c.id = tc.id;
      if (tc.function?.name && !c.name) c.name = tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
    if (parts.length) yield { candidates: [{ content: { role: 'model', parts } }] };
  }
  const parts = calls.filter((c) => c?.name).map((c) => ({ functionCall: { name: c.name, args: parseArgs(c.args), ...(c.id ? { id: c.id } : {}) } }));
  yield {
    candidates: [{
      content: { role: 'model', parts },
      finishReason: { stop: 'STOP', tool_calls: 'STOP', length: 'MAX_TOKENS', content_filter: 'SAFETY' }[finish] || (finish ? finish.toUpperCase() : 'STOP'),
    }],
    ...(usage ? { usageMetadata: { promptTokenCount: usage.prompt_tokens, candidatesTokenCount: usage.completion_tokens } } : {}),
    modelVersion: model,
  };
}

// Gemini contents → OpenAI messages. Tool results are matched to calls by id, or by order.
function toMessages(system, contents) {
  const out = [{ role: 'system', content: system }];
  let callIds = [];
  contents.forEach((c, ci) => {
    if (c.role === 'model') {
      const text = c.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
      const calls = c.parts.filter((p) => p.functionCall);
      callIds = calls.map((p, i) => p.functionCall.id || `call_${ci}_${i}`);
      if (!text && !calls.length) return;
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? {
          tool_calls: calls.map((p, i) => ({ id: callIds[i], type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args || {}) } })),
        } : {}),
      });
      return;
    }
    const results = c.parts.filter((p) => p.functionResponse);
    if (results.length) {
      const images = [];
      results.forEach((p, i) => {
        const fr = p.functionResponse;
        out.push({ role: 'tool', tool_call_id: fr.id || callIds[i] || `call_${ci}_${i}`, content: JSON.stringify(fr.response ?? {}) });
        for (const m of fr.parts || []) if (m.inlineData) images.push(m.inlineData);
      });
      for (const p of c.parts) if (p.inlineData) images.push(p.inlineData);
      if (images.length) out.push({ role: 'user', content: [{ type: 'text', text: 'Photos returned by view_photos, in order:' }, ...images.map(imagePart)] });
      return;
    }
    const content = c.parts.map((p) => (p.inlineData ? imagePart(p.inlineData) : p.text ? { type: 'text', text: p.text } : null)).filter(Boolean);
    if (content.length) out.push({ role: 'user', content });
  });
  return out;
}

const imagePart = (d) => ({ type: 'image_url', image_url: { url: `data:${d.mimeType};base64,${d.data}` } });

// Gemini's schema types are upper case ("OBJECT"); JSON Schema wants lower case.
function toJsonSchema(s) {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== 'object') return s;
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toLowerCase() : toJsonSchema(v)]));
}

function parseArgs(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

async function apiError(res) {
  let message = `${res.status} ${res.statusText}`;
  try {
    const { error } = await res.json();
    if (error?.message) message = error.message;
    if (error?.metadata?.raw) message += ` (${String(error.metadata.raw).slice(0, 200)})`;
  } catch {}
  const err = new Error(`OpenRouter: ${message}`);
  err.status = res.status;
  err.source = 'openrouter';
  return err;
}

function streamError(e) {
  const err = new Error(`OpenRouter: ${e.message || 'error'}`);
  err.status = Number(e.code) || e.code;
  err.source = 'openrouter';
  return err;
}
