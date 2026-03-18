"use strict";
/** System and user prompts for every supported task. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildMessages = buildMessages;
function noteText(note) {
    var _a, _b, _c, _d;
    const transcript = (_a = note.transcription) !== null && _a !== void 0 ? _a : "";
    const title = (_d = (_c = (_b = note.userTitle) !== null && _b !== void 0 ? _b : note.aiTitle) !== null && _c !== void 0 ? _c : note.title) !== null && _d !== void 0 ? _d : "";
    return title ? `Title: ${title}\n\n${transcript}` : transcript;
}
function buildMessages(payload) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k;
    const { task, note, existingTags, messages, contextNotes, contextChunks } = payload;
    switch (task) {
        case "summarize": {
            const text = noteText(note);
            return [
                {
                    role: "system",
                    content: "Summarize this voice note in 2-3 sentences. Be concise and capture the key points. Return plain text only.",
                },
                { role: "user", content: text },
            ];
        }
        case "title": {
            const text = noteText(note);
            return [
                {
                    role: "system",
                    content: "Generate a short, descriptive title (max 8 words) for this voice note. Return the title only, no quotes or punctuation at the end.",
                },
                { role: "user", content: text },
            ];
        }
        case "actions": {
            const text = noteText(note);
            return [
                {
                    role: "system",
                    content: 'Extract actionable to-do items from this voice note. Return a JSON array of strings. Example: ["Call John", "Review document"]. Return only the JSON array. If none, return [].',
                },
                { role: "user", content: text },
            ];
        }
        case "tags": {
            const text = noteText(note);
            const existing = (existingTags !== null && existingTags !== void 0 ? existingTags : []).join(", ");
            return [
                {
                    role: "system",
                    content: `Suggest 1-5 tags for this voice note. Existing tags: ${existing || "none"}. Return a JSON array of lowercase strings. Example: ["work", "meeting"]. Return only the JSON array.`,
                },
                { role: "user", content: text },
            ];
        }
        case "enhanceAll": {
            const text = noteText(note);
            const existing = (existingTags !== null && existingTags !== void 0 ? existingTags : []).join(", ");
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
                { role: "user", content: text },
            ];
        }
        case "chat": {
            const noteContext = (contextNotes !== null && contextNotes !== void 0 ? contextNotes : [])
                .map((n) => `Note: ${noteText(n)}`)
                .join("\n\n---\n\n");
            const chunkContext = (contextChunks !== null && contextChunks !== void 0 ? contextChunks : [])
                .map((rc) => {
                const title = rc.chunk.noteTitle ? `[${rc.chunk.noteTitle}] ` : "";
                return `${title}${rc.chunk.content}`;
            })
                .join("\n\n---\n\n");
            const context = chunkContext || noteContext;
            const systemMsg = {
                role: "system",
                content: context
                    ? `You are a voice note assistant. Answer the user's question using ONLY the context from their notes below. Do NOT use your general knowledge. If the notes don't contain enough information to answer, say: "I couldn't find enough information about that in your notes." Be concise and direct.\n\n--- User's Notes ---\n${context}\n---`
                    : `You are a voice note assistant. The user asked a question but no relevant notes were found. Respond with: "I couldn't find anything about that in your notes." Do NOT answer from your general knowledge.`,
            };
            return [systemMsg, ...(messages !== null && messages !== void 0 ? messages : [])];
        }
        case "custom": {
            return [
                { role: "system", content: (_a = payload.systemPrompt) !== null && _a !== void 0 ? _a : "You are a helpful assistant." },
                { role: "user", content: (_b = payload.userPrompt) !== null && _b !== void 0 ? _b : "" },
            ];
        }
        case "mainPoints": {
            const text = noteText(note);
            return [
                {
                    role: "system",
                    content: "Extract 3-5 bullet points from this transcript. One line each. Direct and factual. Return plain text only.",
                },
                { role: "user", content: text },
            ];
        }
        case "meetingReport": {
            const text = noteText(note);
            return [
                {
                    role: "system",
                    content: "Format this transcript as a meeting report. Use these sections where applicable: Attendees, Key Decisions, Action Items, Next Steps. Only include sections you can fill from the transcript — never use placeholders like \"[Insert Date]\" or \"[Insert Name]\". Omit any section that has no relevant content. Do not repeat the title. Use clear headings. Return plain text only.",
                },
                { role: "user", content: text },
            ];
        }
        case "cleanupTranscript": {
            let transcript = (_c = note.transcription) !== null && _c !== void 0 ? _c : "";
            // Strip any leading "Title:" line that may have been saved from a previous run
            const firstLine = (_e = (_d = transcript.trimStart().split("\n")[0]) === null || _d === void 0 ? void 0 : _d.trim()) !== null && _e !== void 0 ? _e : "";
            if (firstLine.startsWith("Title:") || firstLine.startsWith("**Title:**")) {
                transcript = transcript.trimStart().split("\n").slice(1).join("\n").trim();
            }
            return [
                {
                    role: "system",
                    content: "Fix typos, punctuation, and line breaks in this transcript. Preserve meaning. Do not add any title, header, or prefix. Output only the transcript text with fixes applied, no commentary.",
                },
                { role: "user", content: transcript },
            ];
        }
        case "draftEmail": {
            const text = noteText(note);
            return [
                {
                    role: "system",
                    content: "Draft a professional email summarizing this content. Include Subject line and body. Concise and clear.",
                },
                { role: "user", content: text },
            ];
        }
        case "draftBlog": {
            const text = noteText(note);
            return [
                {
                    role: "system",
                    content: "Draft a short blog post (2-3 paragraphs) from this content. Engaging and readable.",
                },
                { role: "user", content: text },
            ];
        }
        case "translate": {
            const text = noteText(note);
            const lang = (_f = payload.targetLang) !== null && _f !== void 0 ? _f : "Spanish";
            return [
                {
                    role: "system",
                    content: `Translate this transcript to ${lang}. Preserve tone and structure. Output the translation only.`,
                },
                { role: "user", content: text },
            ];
        }
        case "draftTweet": {
            const text = noteText(note);
            return [
                {
                    role: "system",
                    content: "Draft a tweet (max 280 characters) summarizing this content. Engaging and concise.",
                },
                { role: "user", content: text },
            ];
        }
        case "cleanupAndTitle": {
            const transcript = (_g = note.transcription) !== null && _g !== void 0 ? _g : "";
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
                { role: "user", content: transcript },
            ];
        }
        case "moodAnalysis": {
            const entries = (_h = payload.moodEntries) !== null && _h !== void 0 ? _h : [];
            const lang = (_j = payload.language) !== null && _j !== void 0 ? _j : "en";
            const langMap = {
                en: "English", es: "Spanish", fr: "French", de: "German",
                zh: "Simplified Chinese", ar: "Arabic", pt: "Portuguese",
                ja: "Japanese", nl: "Dutch", sv: "Swedish",
            };
            const langName = (_k = langMap[lang]) !== null && _k !== void 0 ? _k : "English";
            const langLine = `Respond entirely in ${langName}.`;
            const system = `You are a mood-coaching AI. ${langLine}

INPUT: A JSON array of mood entries, each with date, moodType (Very Happy / Happy / Neutral / Sad / Very Sad), activities, note, and sleepHours.

OUTPUT: A JSON object with a single key "cards" containing an array of exactly 6 objects. Each object has:
- "title": short emotionally engaging heading with 1-2 emojis (max 8 words)
- "content": rich Markdown (## headers, **bold**, bullet points, emojis for tone). 4-6 sections per card, multiple paragraphs. Reference the user's actual data.
- "cardColor": soft HEX background color suitable for dark text

Markdown rules: only ## headers, **bold**, bullet points (• or -), plain text, line breaks, and emojis. No ###, no italic, no links, no code blocks, no tables.

CARD ORDER:
1. Mood Story & Patterns (#FFF3E0) — emotional arc, rhythm, timing patterns, undercurrents, reframes
2. Energy & Activities (#E0F2F1) — energizing vs draining activities, combos, tailored suggestions
3. Sleep & Recovery (#E8F5E8) — sleep rhythm, mood correlation, signs of debt or recovery, 1-2 tips
4. Self-Care Alignment (#E8EAF6) — frequency, gaps, one routine or mindset shift
5. Stress & Coping (#FFF0F5) — triggers from data, coping tools used, micro-strategies
6. Strengths & Next Steps (#F0F8FF) — progress, strengths, 2 growth-oriented action steps

Rules:
- Ground every insight in the actual entries. Never use generic filler.
- Each card must have 4-6 sections with multi-paragraph content.
- Return ONLY valid JSON: {"cards": [...]}. No wrapping text or code fences.`;
            const user = JSON.stringify({ entries }, null, 0);
            return [
                { role: "system", content: system },
                { role: "user", content: user },
            ];
        }
        default:
            throw new Error(`Unknown task: ${task}`);
    }
}
//# sourceMappingURL=prompts.js.map