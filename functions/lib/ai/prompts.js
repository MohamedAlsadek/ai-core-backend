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
    var _a, _b, _c, _d, _e, _f;
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
                    ? `You are a helpful AI assistant for a voice notes app. Use the following notes as context to answer the user's question. Be concise and accurate.\n\n---\n${context}\n---`
                    : "You are a helpful AI assistant for a voice notes app. Be concise and accurate.",
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
        default:
            throw new Error(`Unknown task: ${task}`);
    }
}
//# sourceMappingURL=prompts.js.map