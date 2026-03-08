/** System and user prompts for every supported task. */

export type TaskType =
  | "summarize"
  | "title"
  | "actions"
  | "tags"
  | "chat"
  | "enhanceAll"
  | "custom"
  | "embed";

interface Note {
  id?: number;
  title?: string;
  userTitle?: string;
  aiTitle?: string;
  summary?: string;
  aiSummary?: string;
  transcription?: string;
  createdAt?: string;
}

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ContextChunk {
  chunk: {
    content: string;
    noteTitle?: string;
    noteCreatedAt?: string;
  };
}

export interface TaskPayload {
  task: TaskType;
  note?: Note;
  existingTags?: string[];
  messages?: Message[];
  contextNotes?: Note[];
  contextChunks?: ContextChunk[];
  systemPrompt?: string;
  userPrompt?: string;
  texts?: string[]; // for embed task
}

function noteText(note: Note): string {
  const transcript = note.transcription ?? "";
  const title = note.userTitle ?? note.aiTitle ?? note.title ?? "";
  return title ? `Title: ${title}\n\n${transcript}` : transcript;
}

export function buildMessages(
  payload: TaskPayload,
): {role: "user" | "assistant" | "system"; content: string}[] {
  const {task, note, existingTags, messages, contextNotes, contextChunks} =
    payload;

  switch (task) {
    case "summarize": {
      const text = noteText(note!);
      return [
        {
          role: "system",
          content:
            "Summarize this voice note in 2-3 sentences. Be concise and capture the key points. Return plain text only.",
        },
        {role: "user", content: text},
      ];
    }

    case "title": {
      const text = noteText(note!);
      return [
        {
          role: "system",
          content:
            "Generate a short, descriptive title (max 8 words) for this voice note. Return the title only, no quotes or punctuation at the end.",
        },
        {role: "user", content: text},
      ];
    }

    case "actions": {
      const text = noteText(note!);
      return [
        {
          role: "system",
          content:
            'Extract action items from this voice note. Return a JSON array of strings. Example: ["Call John", "Review document"]. Return only the JSON array.',
        },
        {role: "user", content: text},
      ];
    }

    case "tags": {
      const text = noteText(note!);
      const existing = (existingTags ?? []).join(", ");
      return [
        {
          role: "system",
          content: `Suggest 1-5 tags for this voice note. Existing tags: ${existing || "none"}. Return a JSON array of lowercase strings. Example: ["work", "meeting"]. Return only the JSON array.`,
        },
        {role: "user", content: text},
      ];
    }

    case "enhanceAll": {
      const text = noteText(note!);
      const existing = (existingTags ?? []).join(", ");
      return [
        {
          role: "system",
          content: `You are an AI assistant for a voice notes app. Given a voice note transcript, return a JSON object with these keys:
- "title": short descriptive title (max 8 words)
- "summary": 2-3 sentence summary
- "actions": JSON array of action items (strings), empty array if none
- "tags": 1-5 lowercase tag strings (existing: ${existing || "none"})

Return only valid JSON. No markdown, no explanation.`,
        },
        {role: "user", content: text},
      ];
    }

    case "chat": {
      const noteContext = (contextNotes ?? [])
        .map((n) => `Note: ${noteText(n)}`)
        .join("\n\n---\n\n");

      const chunkContext = (contextChunks ?? [])
        .map((rc) => {
          const title = rc.chunk.noteTitle ? `[${rc.chunk.noteTitle}] ` : "";
          return `${title}${rc.chunk.content}`;
        })
        .join("\n\n---\n\n");

      const context = chunkContext || noteContext;

      const systemMsg: Message = {
        role: "system",
        content: context
          ? `You are a helpful AI assistant for a voice notes app. Use the following notes as context to answer the user's question. Be concise and accurate.\n\n---\n${context}\n---`
          : "You are a helpful AI assistant for a voice notes app. Be concise and accurate.",
      };

      return [systemMsg, ...(messages ?? [])];
    }

    case "custom": {
      return [
        {role: "system", content: payload.systemPrompt ?? "You are a helpful assistant."},
        {role: "user", content: payload.userPrompt ?? ""},
      ];
    }

    default:
      throw new Error(`Unknown task: ${task}`);
  }
}
