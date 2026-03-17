/** System and user prompts for every supported task. */

export type TaskType =
  | "summarize"
  | "title"
  | "actions"
  | "tags"
  | "chat"
  | "enhanceAll"
  | "custom"
  | "embed"
  | "mainPoints"
  | "meetingReport"
  | "cleanupTranscript"
  | "draftEmail"
  | "draftBlog"
  | "translate"
  | "draftTweet"
  | "cleanupAndTitle";

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
  targetLang?: string;
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
            'Extract actionable to-do items from this voice note. Return a JSON array of strings. Example: ["Call John", "Review document"]. Return only the JSON array. If none, return [].',
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
          ? `You are a voice note assistant. Answer the user's question using ONLY the context from their notes below. Do NOT use your general knowledge. If the notes don't contain enough information to answer, say: "I couldn't find enough information about that in your notes." Be concise and direct.\n\n--- User's Notes ---\n${context}\n---`
          : `You are a voice note assistant. The user asked a question but no relevant notes were found. Respond with: "I couldn't find anything about that in your notes." Do NOT answer from your general knowledge.`,
      };

      return [systemMsg, ...(messages ?? [])];
    }

    case "custom": {
      return [
        {role: "system", content: payload.systemPrompt ?? "You are a helpful assistant."},
        {role: "user", content: payload.userPrompt ?? ""},
      ];
    }

    case "mainPoints": {
      const text = noteText(note!);
      return [
        {
          role: "system",
          content:
            "Extract 3-5 bullet points from this transcript. One line each. Direct and factual. Return plain text only.",
        },
        {role: "user", content: text},
      ];
    }

    case "meetingReport": {
      const text = noteText(note!);
      return [
        {
          role: "system",
          content:
            "Format this transcript as a meeting report. Use these sections where applicable: Attendees, Key Decisions, Action Items, Next Steps. Only include sections you can fill from the transcript — never use placeholders like \"[Insert Date]\" or \"[Insert Name]\". Omit any section that has no relevant content. Do not repeat the title. Use clear headings. Return plain text only.",
        },
        {role: "user", content: text},
      ];
    }

    case "cleanupTranscript": {
      let transcript = note!.transcription ?? "";
      // Strip any leading "Title:" line that may have been saved from a previous run
      const firstLine = transcript.trimStart().split("\n")[0]?.trim() ?? "";
      if (firstLine.startsWith("Title:") || firstLine.startsWith("**Title:**")) {
        transcript = transcript.trimStart().split("\n").slice(1).join("\n").trim();
      }
      return [
        {
          role: "system",
          content:
            "Fix typos, punctuation, and line breaks in this transcript. Preserve meaning. Do not add any title, header, or prefix. Output only the transcript text with fixes applied, no commentary.",
        },
        {role: "user", content: transcript},
      ];
    }

    case "draftEmail": {
      const text = noteText(note!);
      return [
        {
          role: "system",
          content:
            "Draft a professional email summarizing this content. Include Subject line and body. Concise and clear.",
        },
        {role: "user", content: text},
      ];
    }

    case "draftBlog": {
      const text = noteText(note!);
      return [
        {
          role: "system",
          content:
            "Draft a short blog post (2-3 paragraphs) from this content. Engaging and readable.",
        },
        {role: "user", content: text},
      ];
    }

    case "translate": {
      const text = noteText(note!);
      const lang = payload.targetLang ?? "Spanish";
      return [
        {
          role: "system",
          content: `Translate this transcript to ${lang}. Preserve tone and structure. Output the translation only.`,
        },
        {role: "user", content: text},
      ];
    }

    case "draftTweet": {
      const text = noteText(note!);
      return [
        {
          role: "system",
          content:
            "Draft a tweet (max 280 characters) summarizing this content. Engaging and concise.",
        },
        {role: "user", content: text},
      ];
    }

    case "cleanupAndTitle": {
      const transcript = note!.transcription ?? "";
      return [
        {
          role: "system",
          content: `You are a minimal transcript editor for a voice notes app. You have two jobs:

1. LIGHTLY CLEAN the transcript — fix only what the speech-to-text engine got wrong.
2. GENERATE a short, descriptive title (max 8 words) from the content.

CLEANUP RULES — BE CONSERVATIVE:
- Add proper punctuation and capitalization. This is your primary job.
- Fix obvious STT misrecognitions where context makes the correct word clear (e.g., "won too free" → "one two three", "their" vs "there").
- Fix garbled or broken words that are clearly STT artifacts, not real speech.
- If an entire segment is garbled beyond recognition, replace with [inaudible]. Do NOT guess.
- NEVER remove words the user actually said. If they said "test test test let's go", keep it exactly.
- NEVER remove filler words (um, uh, like, you know). The user said them — keep them.
- NEVER remove stutters or repetitions. You cannot know if the user repeated intentionally.
- Only fix hallucination loops that are CLEARLY STT artifacts: the exact same long phrase (5+ words) repeating 3+ times in a row with no variation. Short repeated words or phrases are likely real speech — keep them.
- NEVER add, rephrase, or rearrange words. NEVER infer meaning.
- NEVER change names, numbers, dates, or technical terms unless the STT error is obvious from context.
- Do NOT summarize. Preserve full length and every word the user spoke.
- Add paragraph breaks only at clear long pauses or topic shifts.
- When in doubt, keep the original text unchanged.

TITLE RULES:
- Max 8 words, no quotes, no trailing punctuation.
- Descriptive of the main topic, not the first few words.

Return ONLY valid JSON, no markdown, no code blocks:
{"title": "...", "cleanTranscript": "..."}`,
        },
        {role: "user", content: transcript},
      ];
    }

    default:
      throw new Error(`Unknown task: ${task}`);
  }
}
