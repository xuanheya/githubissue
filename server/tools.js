import { AppError } from "./errors.js";

export function registerExcerpt(evidence, hit) {
  if (!hit.found) return hit;
  let record = evidence.find(row => row.kind === "repo_excerpt" && row.url === hit.url);
  if (!record) {
    record = { id: `R${1 + evidence.filter(row => row.kind === "repo_excerpt").length}`, kind: "repo_excerpt",
      label: `${hit.path} · L${hit.firstLine}–L${hit.lastLine}`, excerpt: hit.excerpt, url: hit.url };
    evidence.push(record);
  }
  return { found: true, ...record };
}

export async function runReadTool(repo, name, args, evidence) {
  if (name === "search_repo") return repo.search(args.terms);
  if (name === "read_excerpt") return registerExcerpt(evidence, await repo.excerpt(args.fileId, args.anchor));
  throw new AppError("unknown_tool", "工具未开放。");
}
