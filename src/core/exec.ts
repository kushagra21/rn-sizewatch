import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Runs a command; throws ToolMissingError when the program isn't installed, never on a non-zero exit. */
export type Exec = (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export class ToolMissingError extends Error {
  constructor(readonly tool: string) {
    super(`${tool} not found`);
  }
}

/** Something the user can fix went wrong; the message says how. */
export class UserError extends Error {}

export const exec: Exec = async (file, args, options = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean; code?: string | number };
    if (err.code === "ENOENT") throw new ToolMissingError(file);
    return {
      stdout: err.stdout ?? "",
      stderr: err.killed ? `${file} timed out` : (err.stderr ?? err.message),
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
};

/** The last few non-empty lines of a tool's output, for error messages. */
export const tail = (text: string, lines = 15) =>
  text
    .split("\n")
    .filter((line) => line.trim())
    .slice(-lines)
    .join("\n");
