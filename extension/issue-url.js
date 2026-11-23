export function parseIssueUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.origin !== "https://github.com" || url.username || url.password) return null;
  const match = /^\/([\w-]+)\/([\w.-]+)\/issues\/([1-9]\d{0,14})\/?$/.exec(url.pathname);
  if (!match) return null;
  const [, owner, repo, number] = match;
  return { owner, repo, number, url: `https://github.com/${owner}/${repo}/issues/${number}` };
}
