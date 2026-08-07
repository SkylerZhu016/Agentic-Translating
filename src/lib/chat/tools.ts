// ---------------------------------------------------------------------------
// Chat Tools — OpenAI tool definitions for the R4 chat engine
//
// REPLACE_TEXT_TOOL: the sole tool for the chat completion layer.
// The description must emphasise that old_string MUST be a verbatim unique
// fragment of the current text so the engine can locate it via cascading match.
//
// FILE_READ_TOOL / FILE_EDIT_TOOL / RUN_COMMAND_TOOL: programming tools for the
// dialogue agent (editing code files / inspecting the workspace / running
// commands). Modeled after Claude Code (old_string/new_string exact replace)
// and OpenAI Codex (timeout-bounded command execution). Only the chat agent
// receives them; pipeline agents (worker/review/orchestrate) never do.
// ---------------------------------------------------------------------------

import type { ChatCompletionRequest } from '../llm/client';

/** The replace_text tool — used for native OpenAI function calling (Wave 2 R4). */
export const REPLACE_TEXT_TOOL: NonNullable<ChatCompletionRequest['tools']>[number] = {
  type: 'function',
  function: {
    name: 'replace_text',
    description:
      'Replace a specific, verbatim fragment of the current text with new content. ' +
      'The old_string MUST be an exact, unique substring of the current document. ' +
      'Include enough surrounding context to make the match unambiguous. ' +
      'Stay strictly within the user-requested scope and never make an unsolicited improvement. ' +
      'For multiple explicitly requested edits, call this function once per edit.',
    parameters: {
      type: 'object',
      properties: {
        old_string: {
          type: 'string',
          description: 'The exact, unique text fragment to replace (verbatim from the current text).',
        },
        new_string: {
          type: 'string',
          description: 'The new text to insert in place of old_string.',
        },
      },
      required: ['old_string', 'new_string'],
    },
  },
};

/** The file_read tool — read a workspace file with an optional 1-based line range. */
export const FILE_READ_TOOL: NonNullable<ChatCompletionRequest['tools']>[number] = {
  type: 'function',
  function: {
    name: 'file_read',
    description:
      'Read a text file inside the project workspace and return its content with line numbers. ' +
      'Use this before file_edit to locate the exact old_string to replace. ' +
      'Omit start_line/end_line to read from the beginning; reads are capped, ' +
      'so page through long files with start_line/end_line. ' +
      'Prefer this tool over run_command (cat/type) for better performance and reliability.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file to read. Absolute, or relative to the project root.',
        },
        start_line: {
          type: 'integer',
          description: 'Inclusive 1-based start line. Default: 1.',
        },
        end_line: {
          type: 'integer',
          description: 'Inclusive 1-based end line. Default: until the read cap.',
        },
      },
      required: ['path'],
    },
  },
};

/** The file_edit tool — exact string replacement on a workspace file (Claude Code style). */
export const FILE_EDIT_TOOL: NonNullable<ChatCompletionRequest['tools']>[number] = {
  type: 'function',
  function: {
    name: 'file_edit',
    description:
      'Edit a text file by exact string replacement. old_string MUST occur exactly once ' +
      'in the file (verbatim, including whitespace); otherwise the edit is rejected and ' +
      'the file is left unchanged. Include enough surrounding context to make the match unique. ' +
      'Set replace_all=true only when you intend to replace every occurrence. ' +
      'Keep edits small and focused; for multiple edits, call this function once per edit. ' +
      'The new content is written back with the file\u2019s original line endings.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file to edit. Absolute, or relative to the project root.',
        },
        old_string: {
          type: 'string',
          description: 'The exact, unique text fragment to replace (verbatim from the file).',
        },
        new_string: {
          type: 'string',
          description: 'The replacement text.',
        },
        replace_all: {
          type: 'boolean',
          description: 'Replace every occurrence of old_string. Default: false.',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
};

/** The run_command tool — execute a shell command with a bounded timeout. */
export const RUN_COMMAND_TOOL: NonNullable<ChatCompletionRequest['tools']>[number] = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Execute a shell command inside the project workspace and return its combined output. ' +
      'The command runs with a default 30s timeout (extend via timeout_ms, max 300000). ' +
      'Output is truncated to 48000 characters, keeping the head and the tail. ' +
      'Use this for build/test/lint/status commands. Prefer file_read/file_edit for ' +
      'inspecting or changing file contents.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute, e.g. "npm test" or "node scripts/check.mjs".',
        },
        cwd: {
          type: 'string',
          description: 'Working directory. Default: project root.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Timeout in milliseconds. Default: 30000, max 300000.',
        },
      },
      required: ['command'],
    },
  },
};

/** Aggregate tool list for the dialogue agent (replace_text + programming tools). */
export const CHAT_TOOLS: NonNullable<ChatCompletionRequest['tools']> = [
  REPLACE_TEXT_TOOL,
  FILE_READ_TOOL,
  FILE_EDIT_TOOL,
  RUN_COMMAND_TOOL,
];

