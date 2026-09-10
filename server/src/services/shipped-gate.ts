// Deterministic "shipped" gate (CIR-39): an issue that carries a commit-type
// work product cannot transition to "done" unless the claimed commit really
// exists in the named repo and its real diff matches the files the work
// product claims to have touched. This runs at the same
// executionPolicy.stages boundary in routes/issues.ts that CIR-34's own
// spike proved cannot be bypassed by a direct status PATCH — it is not a
// cooperative checklist item an agent can skip.
//
// Scope (approved 2026-09-10, CIR-39 plan): fires only on issues that already
// carry a "commit" work product — no gate, no claim, nothing to verify.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

const execFileAsync = promisify(execFile);

export interface RepoLocalPathResolver {
  (repo: string): string | null;
}

const DEFAULT_REPO_LOCAL_PATHS: Record<string, string> = {
  circaid: "/Users/ajinkya/Desktop/circaid",
};

function loadConfiguredRepoLocalPaths(): Record<string, string> {
  const raw = process.env.SHIPPED_GATE_REPO_PATHS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const entries = Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      );
      return Object.fromEntries(entries);
    }
  } catch {
    // Malformed env override: fall through to defaults rather than crash a request path.
  }
  return {};
}

export function defaultResolveRepoLocalPath(repo: string): string | null {
  const configured = loadConfiguredRepoLocalPaths();
  return configured[repo] ?? DEFAULT_REPO_LOCAL_PATHS[repo] ?? null;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { cwd });
  return stdout;
}

function normalizeFileList(files: unknown): string[] | null {
  if (!Array.isArray(files)) return null;
  const normalized = files.filter((value): value is string => typeof value === "string" && value.length > 0);
  return normalized.length === files.length ? normalized : null;
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

async function verifyCommitWorkProduct(
  product: IssueWorkProduct,
  resolveRepoLocalPath: RepoLocalPathResolver,
): Promise<void> {
  const metadata = (product.metadata ?? {}) as Record<string, unknown>;
  const repo = typeof metadata.repo === "string" ? metadata.repo : null;
  const sha = typeof metadata.sha === "string" ? metadata.sha : null;
  const claimedFiles = normalizeFileList(metadata.files);

  if (!repo || !sha) {
    throw unprocessable(
      `Shipped gate: commit work product "${product.title}" is missing a repo or commit sha and cannot be verified`,
      { code: "shipped_gate_missing_commit_reference", workProductId: product.id },
    );
  }

  const repoPath = resolveRepoLocalPath(repo);
  if (!repoPath) {
    throw unprocessable(
      `Shipped gate: no local repo path is configured for "${repo}" — cannot verify commit ${sha}`,
      { code: "shipped_gate_unresolvable_repo", workProductId: product.id, repo },
    );
  }

  try {
    await runGit(["cat-file", "-e", `${sha}^{commit}`], repoPath);
  } catch {
    throw unprocessable(
      `Shipped gate: commit ${sha} does not exist in ${repo} (${repoPath}) — this work product's claim does not check out`,
      { code: "shipped_gate_commit_not_found", workProductId: product.id, repo, sha },
    );
  }

  if (!claimedFiles) {
    throw unprocessable(
      `Shipped gate: commit work product "${product.title}" does not list the files it claims to have changed — cannot verify the diff matches the claim`,
      { code: "shipped_gate_missing_file_claim", workProductId: product.id },
    );
  }

  let actualFiles: string[];
  try {
    const stdout = await runGit(["diff-tree", "--no-commit-id", "--name-only", "-r", sha], repoPath);
    actualFiles = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  } catch {
    throw unprocessable(
      `Shipped gate: could not read the diff for commit ${sha} in ${repo} — this work product's claim does not check out`,
      { code: "shipped_gate_diff_unreadable", workProductId: product.id, repo, sha },
    );
  }

  if (!setsEqual(claimedFiles, actualFiles)) {
    throw unprocessable(
      `Shipped gate: commit ${sha} in ${repo} touches different files than this work product claims — claimed [${claimedFiles.join(", ")}], actual [${actualFiles.join(", ")}]`,
      { code: "shipped_gate_file_mismatch", workProductId: product.id, repo, sha, claimedFiles, actualFiles },
    );
  }
}

export async function assertShippedGate(input: {
  workProducts: IssueWorkProduct[];
  resolveRepoLocalPath?: RepoLocalPathResolver;
}): Promise<void> {
  const commitProducts = input.workProducts.filter((product) => product.type === "commit");
  if (commitProducts.length === 0) return;
  const resolveRepoLocalPath = input.resolveRepoLocalPath ?? defaultResolveRepoLocalPath;
  for (const product of commitProducts) {
    await verifyCommitWorkProduct(product, resolveRepoLocalPath);
  }
}
