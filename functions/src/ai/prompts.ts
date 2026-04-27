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
  | "transcribe"
  | "mainPoints"
  | "meetingReport"
  | "cleanupTranscript"
  | "draftEmail"
  | "draftBlog"
  | "translate"
  | "draftTweet"
  | "cleanupAndTitle"
  | "moodAnalysis";

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

/** Legacy v1 mood entry shape — older clients still send this. */
interface MoodEntryData {
  date: string;
  moodType: string;
  activities: string[];
  note: string;
  sleepHours: string | null;
}

/**
 * Schema v2 mood entry — richer and more grounded than v1.
 *
 * Key additions vs v1:
 *  - full ISO datetime with timezone offset (lets the AI talk about "Monday
 *    mornings" without guessing the user's TZ)
 *  - precomputed dayOfWeek + partOfDay buckets (the AI no longer derives
 *    these, which used to produce inconsistent claims)
 *  - activities as objects with human-readable `label` (the AI was previously
 *    pattern-matching opaque slugs like `exercise_walking`)
 *  - numeric `moodScore` (1=verySad..5=veryHappy) for direct correlation work
 */
interface MoodEntryV2 {
  datetime: string;
  dayOfWeek: string;
  partOfDay: string;
  moodScore: number;
  moodLabel: string;
  activities: Array<{categoryId: string; itemId: string; label?: string}>;
  sleepHours?: number;
  sleepStart?: string;
  sleepEnd?: string;
  note: string;
}

/**
 * Precomputed weekly aggregates sent by the client. The AI is told to use
 * these numbers verbatim rather than recomputing from raw entries — that is
 * the single biggest defence against hallucinated stats like "37% drop".
 */
interface MoodSummary {
  scoreScale?: string;
  entryCount?: number;
  uniqueDays?: number;
  avgMoodScore?: number;
  moodDistribution?: Record<string, number>;
  moodScoreByDayOfWeek?: Record<string, number>;
  moodScoreByPartOfDay?: Record<string, number>;
  topActivities?: Array<{itemId: string; label?: string; count: number}>;
  avgSleepHours?: number;
  lowSleepDays?: number;
  moodOnLowSleepDays?: number;
  moodOnNormalSleepDays?: number;
}

interface MoodUserContext {
  totalEntries?: number;
  weeksTracked?: number;
  longestStreakDays?: number;
  isFirstWrap?: boolean;
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

  // moodAnalysis — schema v1 (legacy) and v2 (current). Backend prefers v2 if
  // present, falls back to v1 so older clients still work.
  moodEntries?: MoodEntryData[];
  entries?: MoodEntryV2[];
  summary?: MoodSummary;
  userContext?: MoodUserContext;
  schemaVersion?: number;
  timezone?: string;
  weekStart?: string;
  weekEnd?: string;

  language?: string; // BCP-47 language tag, e.g. "en", "en-US", "pt-BR"
}

function noteText(note: Note): string {
  const transcript = note.transcription ?? "";
  const title = note.userTitle ?? note.aiTitle ?? note.title ?? "";
  return title ? `Title: ${title}\n\n${transcript}` : transcript;
}

/**
 * Map a BCP-47 language tag (e.g. "en", "en-US", "pt-BR", "zh-Hans") to the
 * English name we put into the prompt. The base language is what matters to
 * GPT, but we keep regional hints when they meaningfully change wording
 * (Brazilian vs European Portuguese, Simplified vs Traditional Chinese).
 */
function resolveLanguageName(tag: string): string {
  const normalized = tag.toLowerCase().replace("_", "-");
  const exact: Record<string, string> = {
    "pt-br": "Brazilian Portuguese",
    "pt-pt": "European Portuguese",
    "zh-hans": "Simplified Chinese",
    "zh-hant": "Traditional Chinese",
    "zh-cn": "Simplified Chinese",
    "zh-tw": "Traditional Chinese",
    "en-us": "English",
    "en-gb": "British English",
  };
  if (exact[normalized]) return exact[normalized];

  const base = normalized.split("-")[0];
  const baseMap: Record<string, string> = {
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    zh: "Simplified Chinese",
    ar: "Arabic",
    pt: "Portuguese",
    ja: "Japanese",
    nl: "Dutch",
    sv: "Swedish",
    it: "Italian",
    ru: "Russian",
    ko: "Korean",
    tr: "Turkish",
    hi: "Hindi",
    pl: "Polish",
  };
  return baseMap[base] ?? "English";
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
          ? `You are a helpful voice note assistant. Answer the user's question primarily using the context from their notes below. You may use general knowledge to explain or clarify concepts mentioned in the notes, but never fabricate information the user didn't say. Always make it clear what comes from their notes vs general context. Be concise and direct.\n\n--- User's Notes ---\n${context}\n---`
          : `You are a helpful voice note assistant. No relevant notes were found for this question. Let the user know you didn't find matching notes, but still try to be helpful — offer a brief, general answer if appropriate, and suggest they try rephrasing or asking about a topic they've recorded.`,
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

    case "moodAnalysis": {
      // Prefer schema v2 (`entries`) if the client sent it; fall back to v1
      // (`moodEntries`) so older app versions still work after this deploy.
      const v2Entries = payload.entries ?? [];
      const v1Entries = payload.moodEntries ?? [];
      const isV2 = v2Entries.length > 0;

      const langTag = payload.language ?? "en";
      const langName = resolveLanguageName(langTag);
      const langLine = `Respond entirely in ${langName}.`;

      // Shared instructions across schema versions.
      const cardOrder = `CARD ORDER (six cards, fixed order, fixed colors):
1. Mood Story & Patterns (#FFF3E0) — emotional arc, rhythm, timing patterns, undercurrents, reframes
2. Energy & Activities (#E0F2F1) — energizing vs draining activities, combos, tailored suggestions
3. Sleep & Recovery (#E8F5E8) — sleep rhythm, mood correlation, signs of debt or recovery, 1-2 tips
4. Self-Care Alignment (#E8EAF6) — frequency, gaps, one routine or mindset shift
5. Stress & Coping (#FFF0F5) — triggers from data, coping tools used, micro-strategies
6. Strengths & Next Steps (#F0F8FF) — progress, strengths, 2 growth-oriented action steps`;

      const outputContract = `OUTPUT: A JSON object with a single key "cards" containing an array of exactly 6 objects. Each object has:
- "title": short emotionally engaging heading with 1-2 emojis (max 8 words)
- "content": rich Markdown (## headers, **bold**, bullet points, emojis for tone). 4-6 sections per card, multiple paragraphs. Reference the user's actual data.
- "cardColor": soft HEX background color matching the card order above.

Markdown rules: only ## headers, **bold**, bullet points (• or -), plain text, line breaks, and emojis. No ###, no italic, no links, no code blocks, no tables.`;

      // Safety guardrail every card must respect.
      const safetyLine = `If a note clearly indicates self-harm, crisis, or imminent danger, do not generate behavioural advice. In every card mention that local support resources are listed in the app's settings, in a single calm sentence, and keep the rest of the wrap focused on patterns, not directives.`;

      if (isV2) {
        // ── Schema v2 prompt — uses precomputed stats and rich entry shape.
        // The single most important rule: the AI must use `summary.*` numbers
        // verbatim and never invent statistics. This is what stopped the old
        // prompt from producing made-up "37% drop" style claims.
        const system = `You are a thoughtful mood-coaching AI writing a personalised Weekly Wrap. ${langLine}

INPUT FORMAT
You receive a JSON object with these top-level keys:
- "weekStart" / "weekEnd": ISO dates bracketing the week being analysed.
- "timezone": user's UTC offset, e.g. "+02:00". Treat all entry datetimes in this offset.
- "userContext": { totalEntries, weeksTracked, longestStreakDays, isFirstWrap }. Use these to calibrate the tone — first-wrap users get warmer, more inviting language; long-time users get sharper, more specific observations.
- "summary": precomputed aggregates including avgMoodScore (1-5 scale: 1=verySad..5=veryHappy), moodScoreByDayOfWeek, moodScoreByPartOfDay, topActivities (with labels), and sleep correlations.
- "entries": array of mood entries, each with full datetime + offset, dayOfWeek (Mon..Sun), partOfDay (morning/afternoon/evening/night), moodScore, moodLabel, activities (each with categoryId, itemId, label), sleepHours, and a possibly-truncated user note. Notes have already been scrubbed of obvious PII; treat them as soft signal, not gospel.

NUMERIC GROUNDING — CRITICAL
- Use numbers ONLY from "summary". Do NOT compute new percentages, deltas, or ratios from "entries". If a number you want to mention is not present in summary, drop the number and describe the pattern qualitatively instead.
- When you cite a stat, reference it naturally (e.g. "your Wednesday mood averaged 4.0", not "I calculated that..."). Round to one decimal.
- Never invent activity names. Use the "label" field of each activity. If "label" is missing, refer to the activity vaguely (e.g. "an activity tagged this week") rather than the raw itemId.

VOICE
- Second person, warm, curious. Avoid clinical jargon. Avoid hollow encouragement.
- Highlight specifics from the data — name a day-of-week, a part-of-day, an activity label, a sleep hour count. Vague cards are failed cards.
- One growth-oriented suggestion per card maximum, framed as an experiment ("try…", "notice if…"), never a directive.

${cardOrder}

${outputContract}

SAFETY
${safetyLine}

Return ONLY valid JSON: {"cards": [...]}. No wrapping text, no code fences.`;

        // Forward only the fields the AI actually needs. Stripping unused
        // fields trims a meaningful chunk of input tokens on power users.
        const user = JSON.stringify({
          weekStart: payload.weekStart,
          weekEnd: payload.weekEnd,
          timezone: payload.timezone,
          userContext: payload.userContext ?? {},
          summary: payload.summary ?? {},
          entries: v2Entries,
        });
        return [
          {role: "system", content: system},
          {role: "user", content: user},
        ];
      }

      // ── Schema v1 prompt — legacy fallback, unchanged in spirit but with
      // tighter grounding rules so older clients also benefit from the
      // anti-hallucination work.
      const system = `You are a mood-coaching AI. ${langLine}

INPUT: A JSON array of mood entries, each with date, moodType (Very Happy / Happy / Neutral / Sad / Very Sad), activities (slug strings), note, and sleepHours.

NUMERIC GROUNDING
- Do not invent percentages, ratios, or deltas. If a precise number is unsupported by the entries, describe the pattern qualitatively instead.
- Activity strings are slugs, not human names — refer to them generically (e.g. "a movement-related activity") rather than quoting the raw slug.

${outputContract}

${cardOrder}

SAFETY
${safetyLine}

Return ONLY valid JSON: {"cards": [...]}. No wrapping text, no code fences.`;

      const user = JSON.stringify({entries: v1Entries});
      return [
        {role: "system", content: system},
        {role: "user", content: user},
      ];
    }

    default:
      throw new Error(`Unknown task: ${task}`);
  }
}
