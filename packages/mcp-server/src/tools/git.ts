import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolError } from "../docker.js";
import { truncateHead } from "../truncate.js";

// Read-only by design: only `git log`, `git show` and `git rev-parse` are ever run, without a shell, and every call
// is pinned to one repository under the deploy-history root with --git-dir/--work-tree, so git never discovers
// another repository (such as the one this server's source lives in) by walking up the directory tree.

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_ROOT = path.resolve(process.env.DEPLOY_HISTORY_DIR ?? path.join(here, "../../../../sandbox/.deploy-history"));
const READ_ONLY_COMMANDS = new Set(["log", "show", "rev-parse"]);
const COMMIT_REF = /^(?:[0-9a-f]{4,40}|HEAD(?:~\d{1,3})?)$/i;

async function availableServices(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(HISTORY_ROOT);
  } catch {
    return [];
  }
  const services: string[] = [];
  for (const name of entries.filter((e) => !e.startsWith("."))) {
    const gitDir = await fs.stat(path.join(HISTORY_ROOT, name, ".git")).catch(() => null);
    if (gitDir?.isDirectory()) services.push(name);
  }
  return services.sort();
}

async function git(repo: string, command: string, args: string[]): Promise<string> {
  if (!READ_ONLY_COMMANDS.has(command)) throw new Error(`git ${command} is not allowed`);
  const { stdout } = await execFileAsync(
    "git",
    [`--git-dir=${path.join(repo, ".git")}`, `--work-tree=${repo}`, "--no-pager", "-c", "core.quotepath=off", command, ...args],
    {
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CEILING_DIRECTORIES: HISTORY_ROOT,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    }
  );
  return stdout;
}

async function resolveRepo(service: string): Promise<string> {
  const services = await availableServices();
  if (!services.includes(service)) {
    throw new ToolError(
      services.length === 0
        ? "No deploy history is available for any service."
        : `No deploy history for "${service}". Available: ${services.join(", ")}`
    );
  }
  const repo = path.join(HISTORY_ROOT, service);
  const gitDir = (await git(repo, "rev-parse", ["--absolute-git-dir"])).trim();
  if ((await fs.realpath(gitDir)) !== (await fs.realpath(path.join(repo, ".git")))) {
    throw new ToolError(`Deploy history for "${service}" is not a standalone repository.`);
  }
  return repo;
}

async function listCommits(repo: string, service: string, limit: number): Promise<string> {
  const out = await git(repo, "log", [`-n${limit}`, "--format=%h  %aI  %an <%ae>  %s"]);
  const lines = out.trimEnd().split("\n").filter(Boolean);
  const header = `service: ${service}\ncommits (newest first): ${lines.length} shown (limit=${limit})\n---`;
  return `${header}\n${lines.join("\n")}`;
}

async function showCommit(repo: string, service: string, commit: string, file?: string): Promise<string> {
  try {
    await git(repo, "rev-parse", ["--verify", "--quiet", `${commit}^{commit}`]);
  } catch {
    throw new ToolError(`Unknown commit "${commit}" in the deploy history of "${service}".`);
  }
  const out = await git(repo, "show", [
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--stat",
    "--patch",
    "--format=commit %H%nAuthor: %an <%ae>%nDate:   %aI%n%n%B",
    commit,
    ...(file ? ["--", file] : []),
  ]);
  return `service: ${service}\n---\n${out.trimEnd()}`;
}

export function registerGitHistoryTool(server: McpServer) {
  server.registerTool(
    "inspect_git_history",
    {
      title: "Inspect deploy history",
      description:
        "Read the deploy history (git) of a sandbox service. Without `commit`: the most recent commits (hash, date, " +
        "author, subject), newest first. With `commit`: that commit's message, changed files and diff, optionally " +
        "limited to one `path`. Output is capped at 4000 characters; when capped, the end is dropped and a " +
        "TRUNCATED header says so.",
      inputSchema: {
        service: z.string().describe('Compose service name, e.g. "order-service"'),
        commit: z
          .string()
          .regex(COMMIT_REF, "a commit hash (4-40 hex chars) or HEAD / HEAD~N")
          .optional()
          .describe("Commit hash (or HEAD, HEAD~N) to show in full"),
        limit: z.number().int().min(1).max(50).default(10).describe("Number of commits to list (default 10)"),
        path: z
          .string()
          .regex(/^[^-]/, "must not start with '-'")
          .optional()
          .describe("With `commit`: only show the diff of this file, e.g. src/index.ts"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ service, commit, limit, path: file }) => {
      try {
        const repo = await resolveRepo(service);
        const text = commit
          ? truncateHead(await showCommit(repo, service, commit, file), 'pass "path" to see one file\'s diff')
          : truncateHead(await listCommits(repo, service, limit), 'lower "limit"');
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const message = err instanceof ToolError ? err.message : `Failed to read deploy history: ${String(err)}`;
        return { content: [{ type: "text", text: message }], isError: true };
      }
    }
  );
}
