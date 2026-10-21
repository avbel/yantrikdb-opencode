/**
 * Ask the model to save durable facts through MCP.
 *
 * Raw transcript capture is off (it filled the store with prompts), so the model
 * itself writes memories with `remember`. In a week of Codex work the model read
 * memory but never saved, although the MCP instructions ask for it, so the plugin
 * states the policy with the digest and adds a save check after turns that did
 * real work without one.
 */

export const SAVE_POLICY =
  "Saving: when the user settles a decision or preference, or the work measures or discovers a durable " +
  "fact (a root cause, a limit, a gotcha, where something lives), store it with the YantrikDB `remember` " +
  "tool as one specific, dated, searchable sentence with importance and domain. To change a stored fact, " +
  "`remember` the new value and name what it supersedes (`correct` returns 501 over the HTTP backend). " +
  "Never store secrets, routine progress, code, or anything git already records.";

// Code mode calls MCP tools from a script (`tools.yantrikdb.remember(`), so the save
// shows up only inside the `execute` input, not as a tool name.
const SAVE_CALL = /yantrikdb[._]+(remember|correct)\b/;

interface TurnMessage {
  role?: unknown;
  content?: unknown;
}

export interface TurnActivity {
  tools: number;
  saved: boolean;
}

function toolCalls(content: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is Record<string, unknown> =>
      typeof part === "object" && part !== null && (part as Record<string, unknown>)["type"] === "tool-call",
  );
}

/** Tool activity of the turn before the trailing user message, or undefined when there is none. */
export function previousTurn(messages: readonly TurnMessage[]): TurnActivity | undefined {
  let end = messages.length - 1;
  while (end >= 0 && messages[end]?.role === "user") end -= 1;
  if (end < 0) return undefined;
  const turn: TurnActivity = { tools: 0, saved: false };
  for (let index = end; index >= 0 && messages[index]?.role !== "user"; index -= 1) {
    for (const call of toolCalls(messages[index]?.content)) {
      turn.tools += 1;
      let input = "";
      try {
        input = JSON.stringify(call["input"]) ?? "";
      } catch {
        // An unserializable input cannot name a memory tool either.
      }
      if (SAVE_CALL.test(`${String(call["name"] ?? "")} ${input}`)) turn.saved = true;
    }
  }
  return turn;
}

export function saveNote(messages: readonly TurnMessage[], minTools: number): string {
  const turn = previousTurn(messages);
  if (!turn || turn.saved || turn.tools < minTools) return "";
  return (
    `YantrikDB save check (plugin note, not from the user): the previous turn ran ${turn.tools} tool calls ` +
    "and saved nothing to memory. If it settled a decision or user preference, or established a durable " +
    "fact, `remember` it before continuing; otherwise ignore this note."
  );
}
