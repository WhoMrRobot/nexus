// Calls the Gemini API (generateContent, streamed as server-sent events) straight from the phone.

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

// Gives up when nothing arrives for `idleMs` (a stalled connection otherwise spins forever).
export async function* stream({ key, model, body, signal, idleMs = 75_000 }) {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop);
  let timer;
  // Each wait (for the response, then for every next piece) races a fresh idle timer.
  const idle = () => new Promise((_, reject) => {
    clearTimeout(timer);
    timer = setTimeout(() => { ctrl.abort(); reject(timeoutError(idleMs)); }, idleMs);
  });
  let reader;
  try {
    const res = await Promise.race([
      fetch(`${BASE}${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      }),
      idle(),
    ]);
    if (!res.ok) throw await apiError(res);

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await Promise.race([reader.read(), idle()]);
      if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, '');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
        if (data) yield JSON.parse(data);
      }
      if (chunk.done) break;
    }
    const rest = buffer.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (rest) yield JSON.parse(rest);
  } finally {
    clearTimeout(timer);
    reader?.cancel().catch(() => {});
    signal?.removeEventListener('abort', stop);
  }
}

function timeoutError(ms) {
  const err = new Error(`Gemini: nothing came back for ${Math.round(ms / 1000)} seconds.`);
  err.status = 'timeout';
  err.source = 'gemini';
  return err;
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
