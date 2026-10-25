// Reads a streamed (server-sent events) response as JSON events. Gives up when nothing arrives
// for `idleMs`, because a stalled connection would otherwise spin forever.

export async function* sseEvents({ url, headers, body, signal, idleMs = 75_000, toError, source }) {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  signal?.addEventListener('abort', stop);
  let timer;
  // Each wait (for the response, then for every next piece) races a fresh idle timer.
  const idle = () => new Promise((_, reject) => {
    clearTimeout(timer);
    timer = setTimeout(() => { ctrl.abort(); reject(timeoutError(idleMs, source)); }, idleMs);
  });
  const parse = (event) => {
    const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    return data && data !== '[DONE]' ? JSON.parse(data) : null;
  };
  let reader;
  try {
    const res = await Promise.race([
      fetch(url, { method: 'POST', signal: ctrl.signal, headers, body: JSON.stringify(body) }),
      idle(),
    ]);
    if (!res.ok) throw await toError(res);

    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const chunk = await Promise.race([reader.read(), idle()]);
      if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r/g, '');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        if (event) yield event;
      }
      if (chunk.done) break;
    }
    const last = parse(buffer);
    if (last) yield last;
  } finally {
    clearTimeout(timer);
    reader?.cancel().catch(() => {});
    signal?.removeEventListener('abort', stop);
  }
}

function timeoutError(ms, source) {
  const err = new Error(`${source}: nothing came back for ${Math.round(ms / 1000)} seconds.`);
  err.status = 'timeout';
  err.source = source.toLowerCase();
  return err;
}
