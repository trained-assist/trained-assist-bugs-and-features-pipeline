'use strict';
// Minimal GitHub REST client (fetch, no deps). Every call has a timeout.

const API = 'https://api.github.com';

function client({ token, repo, fetchImpl = fetch }) {
  if (!repo) throw new Error('github: repo is required');
  async function call(method, pathname, body, { allow404 = false } = {}) {
    const res = await fetchImpl(`${API}${pathname}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: 'application/vnd.github+json',
        'User-Agent': 'trained-assist-bugs-and-features-pipeline',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${method} ${pathname} -> HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  }
  const r = `/repos/${repo}`;

  return {
    repo,
    getIssue: (n) => call('GET', `${r}/issues/${n}`),
    listComments: (n) => call('GET', `${r}/issues/${n}/comments?per_page=100`),
    createIssue: ({ title, body, labels }) => call('POST', `${r}/issues`, { title, body, labels }),
    comment: (n, body) => call('POST', `${r}/issues/${n}/comments`, { body }),
    addLabels: (n, labels) => call('POST', `${r}/issues/${n}/labels`, { labels }),
    removeLabel: (n, label) => call('DELETE', `${r}/issues/${n}/labels/${encodeURIComponent(label)}`, null, { allow404: true }),
    createPr: ({ head, base, title, body, draft }) => call('POST', `${r}/pulls`, { head, base, title, body, draft }),

    // Paged issue listing (PRs filtered out). state: open|closed|all.
    async listIssues({ state = 'open', since, maxPages = 10 } = {}) {
      const out = [];
      for (let page = 1; page <= maxPages; page++) {
        const q = `state=${state}&per_page=100&page=${page}${since ? `&since=${encodeURIComponent(since)}` : ''}`;
        const batch = await call('GET', `${r}/issues?${q}`);
        out.push(...batch.filter(i => !i.pull_request));
        if (batch.length < 100) break;
      }
      return out;
    },

    // First issue/PR whose body contains `marker` (idempotency guard). null if none.
    async findByMarker(marker, { type = 'issue', state } = {}) {
      const q = encodeURIComponent(`repo:${repo} is:${type}${state ? ` is:${state}` : ''} in:body "${marker}"`);
      const data = await call('GET', `/search/issues?q=${q}`);
      const item = data && data.items && data.items[0];
      return item ? { number: item.number, url: item.html_url } : null;
    },
  };
}

module.exports = { client };
