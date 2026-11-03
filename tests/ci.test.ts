import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifactName, findLockfile, isRelevant, prepare, run, upsertComment } from "../src/ci/action.js";
import { GitHub, setOutputs, type GitHubContext } from "../src/ci/github.js";
import { COMMENT_MARKER, commentMarker } from "../src/render/markdown.js";
import { argAfter, bareApp, fakeExec, makeDir, ok } from "./helpers.js";

interface Call {
  method: string;
  path: string;
  body?: any;
}

/** A GitHub API answering from `routes` ("GET /path" → body, or a status number for an error). */
function fakeGitHub(routes: Record<string, unknown>, context: Partial<GitHubContext> = {}) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const path = url.replace("https://api.github.com", "");
    const method = init.method ?? "GET";
    calls.push({ method, path, ...(init.body ? { body: JSON.parse(init.body as string) } : {}) });
    const key = Object.keys(routes).find((route) => {
      const [m, p] = route.split(" ");
      return m === method && path.split("?")[0] === p!.split("?")[0] && (!p!.includes("?") || path.includes(p!.split("?")[1]!));
    });
    const answer = key === undefined ? 404 : routes[key];
    if (typeof answer === "number") return new Response("nope", { status: answer });
    return new Response(JSON.stringify(answer), { status: method === "POST" ? 201 : 200 });
  }) as typeof fetch;
  const github = new GitHub(
    { api: "https://api.github.com", repo: "me/app", token: "t", eventName: "push", event: {}, sha: "h".repeat(40), ...context },
    fetchFn,
  );
  return { github, calls };
}

const prEvent = { pull_request: { number: 7, base: { sha: "b".repeat(40) } } };

describe("isRelevant", () => {
  it("counts files that can change the bundle, not native ones", () => {
    for (const file of ["src/App.tsx", "app.json", "assets/logo.png", "package.json", "yarn.lock", "pnpm-lock.yaml", "babel.config.js", "fonts/Inter.ttf"]) expect(isRelevant(file)).toBe(true);
    for (const file of ["ios/Podfile", "android/app/build.gradle", "ios/App/AppDelegate.swift", "README.md", ".github/workflows/ci.yml"]) expect(isRelevant(file)).toBe(false);
  });
});

describe("findLockfile", () => {
  it("finds the nearest lockfile up to the repository root and how to install from it", () => {
    const repo = makeDir({ "yarn.lock": "", ".yarnrc.yml": "", "apps/mobile/package.json": {} });
    expect(findLockfile(join(repo, "apps/mobile"), repo)).toEqual({ dir: repo, file: "yarn.lock", install: ["yarn", "install", "--immutable"] });
    expect(findLockfile(makeDir({ "package-lock.json": "" }), "/")?.install).toEqual(["npm", "ci", "--no-audit", "--no-fund"]);
    expect(findLockfile(makeDir({ "a/b": "" }), "/")).toBeUndefined();
  });
});

describe("prepare", () => {
  it("measures a push as a baseline under the commit's name", async () => {
    const { github } = fakeGitHub({});
    const prepared = await prepare(github, { cwd: makeDir({ "package-lock.json": "{}" }) });
    expect(prepared).toMatchObject({ mode: "baseline", artifact: `rn-sizewatch-${"h".repeat(40)}` });
    expect(prepared.cacheKey).toMatch(new RegExp(`^rn-sizewatch-metro-${process.platform}-[0-9a-f]{16}-h{40}$`));
    expect(prepared.cacheRestoreKeys.split("\n")).toHaveLength(2);
  });

  it("finds the base commit's saved measurement for a pull request", async () => {
    const { github, calls } = fakeGitHub(
      {
        "GET /repos/me/app/pulls/7/files": [{ filename: "android/build.gradle" }, { filename: "src/App.tsx" }],
        "GET /repos/me/app/actions/artifacts": { artifacts: [{ expired: true, workflow_run: { id: 1 } }, { expired: false, workflow_run: { id: 42 } }] },
      },
      { eventName: "pull_request", event: prEvent },
    );
    const prepared = await prepare(github, { cwd: makeDir({}), name: "mobile app" });
    expect(prepared).toMatchObject({ mode: "pr", prNumber: 7, baseSha: "b".repeat(40), baseArtifact: `rn-sizewatch-mobile-app-${"b".repeat(40)}`, baseRunId: "42" });
    expect(calls.find((c) => c.path.includes("artifacts"))!.path).toContain(`name=rn-sizewatch-mobile-app-${"b".repeat(40)}`);
  });

  it("leaves the base to be built when nothing was saved, and skips PRs that touch nothing relevant", async () => {
    const saved = fakeGitHub(
      { "GET /repos/me/app/pulls/7/files": [{ filename: "src/a.ts" }], "GET /repos/me/app/actions/artifacts": { artifacts: [] } },
      { eventName: "pull_request", event: prEvent },
    );
    const prepared = await prepare(saved.github, { cwd: makeDir({}) });
    expect(prepared.mode).toBe("pr");
    expect(prepared.baseRunId).toBeUndefined();

    const native = fakeGitHub({ "GET /repos/me/app/pulls/7/files": [{ filename: "ios/Podfile" }] }, { eventName: "pull_request", event: prEvent });
    expect(await prepare(native.github, { cwd: makeDir({}) })).toMatchObject({ mode: "skip", reason: expect.stringContaining("no file") });
  });
});

describe("upsertComment", () => {
  it("edits the bot's own comment, never someone else's", async () => {
    const { github, calls } = fakeGitHub({
      "GET /repos/me/app/issues/7/comments": [
        { id: 1, body: `quoting ${COMMENT_MARKER}`, user: { type: "User" } },
        { id: 2, body: `${COMMENT_MARKER}\nold`, user: { type: "Bot" } },
      ],
      "PATCH /repos/me/app/issues/comments/2": {},
    });
    expect(await upsertComment(github, 7, "new", COMMENT_MARKER)).toBe("updated");
    expect(calls.at(-1)).toEqual({ method: "PATCH", path: "/repos/me/app/issues/comments/2", body: { body: "new" } });
  });

  it("creates one when there's none, keeps apps apart, and copes with a read-only token", async () => {
    const created = fakeGitHub({ "GET /repos/me/app/issues/7/comments": [{ id: 2, body: COMMENT_MARKER, user: { type: "Bot" } }], "POST /repos/me/app/issues/7/comments": {} });
    expect(await upsertComment(created.github, 7, "x", commentMarker("web"))).toBe("created");
    const fork = fakeGitHub({ "GET /repos/me/app/issues/7/comments": [], "POST /repos/me/app/issues/7/comments": 403 });
    expect(await upsertComment(fork.github, 7, "x", COMMENT_MARKER)).toBe("forbidden");
  });
});

describe("run", () => {
  const app = () => bareApp({ "node_modules/lodash/package.json": { version: "4.17.21" }, "package-lock.json": "{}" });

  it("measures a baseline without touching GitHub", async () => {
    const root = app();
    const tmp = makeDir({});
    const result = await run(undefined, { cwd: root, mode: "baseline", tmp, comment: true, version: "0.1.0" }, { exec: fakeExec(), log: () => {} });
    expect(result).toEqual({ measureFile: join(tmp, "head/measure.json"), failed: false });
  });

  it("compares with the downloaded base, comments, and reports a failed budget", async () => {
    const root = app();
    writeFileSync(join(root, "sizewatch.config.json"), JSON.stringify({ budgets: { js: "10 B" } }));
    const tmp = makeDir({});
    const exec = fakeExec();
    // The base: the same app measured before.
    const first = await run(undefined, { cwd: root, mode: "baseline", tmp: join(tmp, "first"), comment: false, version: "0" }, { exec, log: () => {} });
    const { github, calls } = fakeGitHub({ "GET /repos/me/app/issues/7/comments": [], "POST /repos/me/app/issues/7/comments": {} });

    const result = await run(github, { cwd: root, mode: "pr", tmp, baseFile: first.measureFile, prNumber: 7, headSha: "f".repeat(40), comment: true, version: "0.1.0" }, { exec, log: () => {} });
    expect(result.failed).toBe(true);
    expect(result.commented).toBe("created");
    expect(result.baseBuiltFile).toBeUndefined();
    expect(calls.at(-1)!.body.body).toContain("No size changes.");
    expect(calls.at(-1)!.body.body).toContain("❌ **Budgets:**");
    // The comment names the pull request's commit, not GitHub's merge commit that was measured.
    expect(calls.at(-1)!.body.body).toContain("head `fffffff`");
  });

  it("builds the base commit in a worktree, installed with the project's package manager, when nothing was saved", async () => {
    const root = app();
    const tmp = makeDir({});
    const exec = fakeExec({
      other: (file, args) => {
        if (file !== "git" && file !== "npm") return undefined;
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${root}\n`);
        // The base commit is the same app, checked out into the worktree folder.
        if (args[0] === "worktree") cpSync(root, args.at(-2)!, { recursive: true });
        return ok();
      },
    });
    const result = await run(undefined, { cwd: root, mode: "pr", tmp, baseSha: "b".repeat(40), comment: false, version: "0" }, { exec, log: () => {} });

    expect(result.baseBuiltFile).toBe(join(tmp, "base/measure.json"));
    const commands = exec.calls.filter((c) => c[0] === "git" || c[0] === "npm").map((c) => c.slice(0, 3).join(" "));
    expect(commands).toEqual(expect.arrayContaining(["git fetch --no-tags", "git worktree add", "npm ci --no-audit"]));
    // The base was bundled from the worktree, not the original checkout.
    const bundles = exec.calls.filter((c) => c[0] === process.execPath).map((c) => argAfter(c, "--bundle-output"));
    expect(bundles.some((b) => b.startsWith(join(tmp, "base")))).toBe(true);
  });
});

describe("setOutputs", () => {
  it("writes multi-line values in the heredoc form", () => {
    const file = join(makeDir({}), "out");
    writeFileSync(file, "");
    setOutputs({ mode: "pr", paths: "a\nb", empty: undefined }, { GITHUB_OUTPUT: file });
    expect(readFileSync(file, "utf8")).toBe("mode=pr\npaths<<RN_SIZEWATCH_EOF\na\nb\nRN_SIZEWATCH_EOF\nempty=\n");
  });
});

describe("artifactName", () => {
  it("keeps names to characters artifacts allow", () => {
    expect(artifactName("abc", "apps/mobile: main")).toBe("rn-sizewatch-apps-mobile-main-abc");
  });
});

