// Calls the Gemini API (generateContent, streamed as server-sent events) straight from the phone.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export async function* stream({ key, model, body, signal }) {
  const res = await fetch(`${BASE}${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (data) yield JSON.parse(data);
    }
    if (done) break;
  }
  const rest = buffer.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
  if (rest) yield JSON.parse(rest);
}

export async function checkModel(key, model) {
  const res = await fetch(`${BASE}${encodeURIComponent(model)}`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw await apiError(res);
  return res.json();
}

async function apiError(res) {
  let message = `${res.status} ${res.statusText}`;
  let retryDelay;
  try {
    const { error } = await res.json();
    if (error?.message) message = error.message;
    const info = error?.details?.find((d) => String(d['@type']).includes('RetryInfo'));
    if (info?.retryDelay) retryDelay = parseFloat(info.retryDelay);
  } catch {}
  const err = new Error(`Gemini: ${message}`);
  err.status = res.status;
  err.retryDelay = retryDelay;
  err.source = 'gemini';
  return err;
}
