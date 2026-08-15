const UA = 'umatool-data-bot/1.0 (+https://github.com/DualChimerra/umatool)';

export async function getText(url, { retries = 4, timeout = 30000, headers = {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt) await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'user-agent': UA, accept: '*/*', ...headers },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export async function getJson(url, opts) {
  return JSON.parse(await getText(url, opts));
}
