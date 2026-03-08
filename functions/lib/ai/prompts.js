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
    var _a, _b;
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
                    content: 'Extract action items from this voice note. Return a JSON array of strings. Example: ["Call John", "Review document"]. Return only the JSON array.',
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
        default:
            throw new Error(`Unknown task: ${task}`);
    }
}
//# sourceMappingURL=prompts.js.map