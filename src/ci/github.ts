import { appendFileSync, readFileSync } from "node:fs";
import { UserError } from "../core/exec.js";

export interface GitHubContext {
  api: string;
  /** owner/name */
  repo: string;
  token: string;
  eventName: string;
  event: Record<string, any>;
  sha: string;
}

export type Fetch = typeof fetch;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What GitHub Actions puts in the environment of a step. */
export function githubContext(env: NodeJS.ProcessEnv = process.env): GitHubContext {
  const missing = ["GITHUB_REPOSITORY", "GITHUB_EVENT_NAME", "GITHUB_EVENT_PATH", "GITHUB_SHA"].filter((key) => !env[key]);
  if (missing.length) throw new UserError(`rn-sizewatch ci runs inside GitHub Actions; ${missing.join(", ")} isn't set.`);
  const token = env.RN_SIZEWATCH_TOKEN || env.GITHUB_TOKEN || "";
  if (!token) throw new UserError("No GitHub token: pass github-token to the action.");
  return {
    api: env.GITHUB_API_URL || "https://api.github.com",
    repo: env.GITHUB_REPOSITORY!,
    token,
    eventName: env.GITHUB_EVENT_NAME!,
    event: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, "utf8")),
    sha: env.GITHUB_SHA!,
  };
}

export class GitHub {
  constructor(
    readonly context: GitHubContext,
    private readonly fetchFn: Fetch = fetch,
  ) {}

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.fetchFn(`${this.context.api}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${this.context.token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "rn-sizewatch",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new GitHubError(response.status, `GitHub ${method} ${path} failed: ${response.status} ${await response.text()}`);
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  /** Every item of a list endpoint, up to `max`. `pick` gets the array out of wrapped responses. */
  async list<T>(path: string, max = 3000, pick: (page: any) => T[] = (page) => page): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; items.length < max; page++) {
      const batch = pick(await this.request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`));
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items.slice(0, max);
  }
}

/** Sets step outputs; multi-line values use the heredoc form. */
export function setOutputs(outputs: Record<string, string | undefined>, env: NodeJS.ProcessEnv = process.env) {
  const lines = Object.entries(outputs).map(([key, value = ""]) => (value.includes("\n") ? `${key}<<RN_SIZEWATCH_EOF\n${value}\nRN_SIZEWATCH_EOF` : `${key}=${value}`));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  else console.log(lines.join("\n"));
}

export function addSummary(markdown: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}
