// Calls the Gemini API (generateContent, streamed as server-sent events) straight from the phone.
import { sseEvents } from './sse.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export function stream({ key, model, body, signal }) {
  return sseEvents({
    url: `${BASE}${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body,
    signal,
    toError: apiError,
    source: 'Gemini',
  });
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
