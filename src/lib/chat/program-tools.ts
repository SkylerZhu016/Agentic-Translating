// ---------------------------------------------------------------------------
// Programming tool executors for the dialogue agent.
//
// Modeled on production implementations:
// - file_read:   Cline read_files (1-based line ranges, capped output)
// - file_edit:   Claude Code Edit (exact unique old_string, EOL preservation)
// - run_command: Cline bash executor (timeout + process-tree kill + rolling
//                output collector) and OpenAI Codex local_shell (bounded)
//
// Safety: every file access is confined to the project root; command output
// is truncated; commands are killed after the timeout.
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_READ_LINES = 2_000;
const MAX_LINE_CHARS = 2_000;
const MAX_OUTPUT_CHARS = 48_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;

export interface ProgramToolResult {
  ok: boolean;
  /** Text fed back to the model as the tool result content. */
  content: string;
}

/** Resolve a user-supplied path against the project root and confine it there. */
function resolveWorkspacePath(rawPath: string): string {
  const root = process.cwd();
  const resolved = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.resolve(root, rawPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path escapes the project root: ${rawPath}`);
  }
  return resolved;
}

function detectLineEnding(text: string): '\r\n' | '\n' {
  const crlf = text.indexOf('\r\n');
  const lf = text.indexOf('\n');
  if (crlf === -1) return '\n';
  if (lf === -1) return '\r\n';
  return crlf <= lf ? '\r\n' : '\n';
}

function truncateOutput(text: string, budget: number = MAX_OUTPUT_CHARS): string {
  if (text.length <= budget) return text;
  const half = Math.floor(budget / 2);
  return (
    text.slice(0, half) +
    `\n\n… [output truncated, ${text.length - budget} characters omitted] …\n\n` +
    text.slice(-half)
  );
}

/** Read a workspace file with 1-based line ranges, echoing numbered lines. */
async function executeFileRead(args: Record<string, unknown>): Promise<ProgramToolResult> {
  try {
    const filePath = resolveWorkspacePath(String(args.path ?? ''));
    const text = await readFile(filePath, 'utf8');
    if (text.length > 5 * 1024 * 1024) {
      return { ok: false, content: `Error: file too large to read (${text.length} bytes > 5MB cap).` };
    }
    const lines = text.split(/\r\n|\n/);
    const start = Number.isInteger(args.start_line) ? Math.max(1, args.start_line as number) : 1;
    const end =
      Number.isInteger(args.end_line) && (args.end_line as number) >= start
        ? (args.end_line as number)
        : Math.min(lines.length, start + MAX_READ_LINES - 1);
    const slice = lines.slice(start - 1, end);
    const rendered = slice
      .map((line, i) => {
        const num = start + i;
        const content = line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '… [line truncated]' : line;
        return `${num}: ${content}`;
      })
      .join('\n');
    const header = `${path.basename(filePath)} (${end - start + 1} lines shown, ${lines.length} total)`;
    const body = truncateOutput(rendered);
    if (end < lines.length) {
      return {
        ok: true,
        content: `${header}\n${body}\n… [file continues; request start_line=${end + 1} to page further]`,
      };
    }
    return { ok: true, content: `${header}\n${body}` };
  } catch (error: unknown) {
    return { ok: false, content: `Error reading file: ${(error as Error).message}` };
  }
}

/** Exact unique-string replacement on a workspace file (Claude Code Edit style). */
async function executeFileEdit(args: Record<string, unknown>): Promise<ProgramToolResult> {
  try {
    const filePath = resolveWorkspacePath(String(args.path ?? ''));
    const oldString = String(args.old_string ?? '');
    const newString = String(args.new_string ?? '');
    const replaceAll = args.replace_all === true;
    if (!oldString) {
      return { ok: false, content: 'Error: old_string must not be empty.' };
    }
    const original = await readFile(filePath, 'utf8');
    const eol = detectLineEnding(original);
    const normalizedOld = oldString.replace(/\r\n|\n/g, eol);
    const normalizedNew = newString.replace(/\r\n|\n/g, eol);

    let nextIndex = original.indexOf(normalizedOld);
    if (nextIndex === -1) {
      return {
        ok: false,
        content:
          'Error: old_string not found in the file (verbatim match required). ' +
          'Read the file first with file_read and copy the exact text, including whitespace and line endings.',
      };
    }
    if (!replaceAll) {
      const secondIndex = original.indexOf(normalizedOld, nextIndex + normalizedOld.length);
      if (secondIndex !== -1) {
        return {
          ok: false,
          content:
            'Error: old_string matches multiple locations. Include more surrounding context ' +
            'to make it unique, or set replace_all=true to replace every occurrence.',
        };
      }
    }

    const updated = replaceAll
      ? original.split(normalizedOld).join(normalizedNew)
      : original.slice(0, nextIndex) + normalizedNew + original.slice(nextIndex + normalizedOld.length);
    await writeFile(filePath, updated, 'utf8');
    return {
      ok: true,
      content: `Edited ${path.relative(process.cwd(), filePath) || path.basename(filePath)}: ` +
        `${JSON.stringify(oldString)} → ${JSON.stringify(newString)}` +
        (replaceAll ? ' (all occurrences)' : ''),
    };
  } catch (error: unknown) {
    return { ok: false, content: `Error editing file: ${(error as Error).message}` };
  }
}

/** Run a shell command with timeout and process-tree kill (Cline bash pattern). */
async function executeRunCommand(args: Record<string, unknown>): Promise<ProgramToolResult> {
  const command = String(args.command ?? '').trim();
  if (!command) {
    return { ok: false, content: 'Error: command must not be empty.' };
  }
  let cwd: string;
  try {
    cwd = args.cwd ? resolveWorkspacePath(String(args.cwd)) : process.cwd();
  } catch (error: unknown) {
    return { ok: false, content: `Error: ${(error as Error).message}` };
  }
  const timeoutMs = Number.isInteger(args.timeout_ms)
    ? Math.min(Math.max(args.timeout_ms as number, 1_000), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;

  const shell = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];

  return await new Promise<ProgramToolResult>((resolve) => {
    const child = spawn(shell, shellArgs, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: ProgramToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid && !child.killed) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
          } else {
            process.kill(-child.pid, 'SIGKILL');
          }
        } catch {
          /* already dead */
        }
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      const partial = truncateOutput(
        `[Command timed out after ${timeoutMs}ms]\n${stdout}${stderr}`.trim(),
      );
      finish({ ok: false, content: partial });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => {
      finish({ ok: false, content: `Error launching command: ${error.message}` });
    });
    child.on('close', (code) => {
      const combined = `${stdout}${stderr}`.trim();
      const truncated = truncateOutput(combined);
      if (code === 0) {
        finish({ ok: true, content: truncated || '(no output)' });
      } else {
        finish({
          ok: false,
          content: `[Command exited with code ${code}]\n${truncated}`,
        });
      }
    });
  });
}

/** Dispatch a programming tool call; unknown names return a stable error. */
export async function executeProgrammaticTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ProgramToolResult> {
  switch (name) {
    case 'file_read':
      return executeFileRead(args);
    case 'file_edit':
      return executeFileEdit(args);
    case 'run_command':
      return executeRunCommand(args);
    default:
      return { ok: false, content: `Unknown tool — ignored.` };
  }
}
