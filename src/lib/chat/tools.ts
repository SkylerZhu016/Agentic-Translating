// ---------------------------------------------------------------------------
// Chat Tools — OpenAI tool definitions for the R4 chat engine
//
// REPLACE_TEXT_TOOL: the sole tool for the chat completion layer.
// The description must emphasise that old_string MUST be a verbatim unique
// fragment of the current text so the engine can locate it via cascading match.
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
