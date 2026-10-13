export function createApi(token) {
  return async function request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('x-pi-token', token);
    let body;
    if (options.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(options.json);
    } else {
      body = options.body;
    }
    const res = await fetch(url, { method: options.method || 'GET', headers, body });
    if (options.raw) {
      if (!res.ok) throw await toError(res);
      return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || '요청이 실패했습니다.');
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  };
}

async function toError(res) {
  const data = await res.json().catch(() => ({}));
  const err = new Error(data.error || '요청이 실패했습니다.');
  err.status = res.status;
  err.data = data;
  return err;
}
