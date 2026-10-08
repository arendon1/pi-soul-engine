/**
 * HeuristicEngine — deterministic CognitiveEngine fallback.
 *
 * Word-list sentiment, formula significance, regex fact extraction. No
 * hallucination, no network, no crashes. Answers the same task-tagged prompts
 * as any LLM engine, in the same JSON shapes.
 */
import { clamp, keywords, tokenize } from "../../util/text.ts";
import type { CognitiveEngine, ThinkOptions } from "./engine.ts";
import { contentRichness, heuristicSentiment } from "../psychology.ts";
import type { EngineTask } from "./prompts.ts";

function taskOf(prompt: string): EngineTask | null {
	const match = prompt.match(/^TASK:\s*(\w+)/m);
	return (match?.[1] as EngineTask) ?? null;
}

function subjectOf(prompt: string): { user: string; agent: string; text: string } {
	const user = prompt.match(/USER: ([\s\S]*?)(?:\nAGENT:|$)/)?.[1]?.trim() ?? "";
	const agent = prompt.match(/AGENT: ([\s\S]*?)$/)?.[1]?.trim() ?? "";
	const text = prompt.match(/TEXT: ([\s\S]*?)$/)?.[1]?.trim() ?? user + " " + agent;
	return { user, agent, text };
}

// Fact extraction: "I <verb> …" / "my X is Y" / "I prefer …" style statements.
const FACT_PATTERNS: Array<{ re: RegExp; build: (m: RegExpMatchArray) => string }> = [
	{ re: /\bI (?:prefer|like|love|use|want|need) ([^.;!?\n]+)/gi, build: (m) => `Human prefers ${m[1]!.trim()}` },
	{ re: /\bI (?:hate|dislike|can't stand|do not like) ([^.;!?\n]+)/gi, build: (m) => `Human dislikes ${m[1]!.trim()}` },
	{ re: /\bI(?:'m| am) (?:a |an )?([^.;!?\n]+)/gi, build: (m) => `Human is ${m[1]!.trim()}` },
	{ re: /\bI work (?:at|on|with|for) ([^.;!?\n]+)/gi, build: (m) => `Human works with ${m[1]!.trim()}` },
	{ re: /\bmy ([a-z][\w ]{2,30}) (?:is|are) ([^.;!?\n]+)/gi, build: (m) => `Human's ${m[1]!.trim()} is ${m[2]!.trim()}` },
	{ re: /\bwe(?:'re| are) (?:using|building|working on) ([^.;!?\n]+)/gi, build: (m) => `Project context: ${m[1]!.trim()}` },
	{ re: /\bplease (?:always|never) ([^.;!?\n]+)/gi, build: (m) => `Preference: ${m[0]!.trim()}` },
];

const DOMAIN_HINTS: Array<{ domain: string; words: string[] }> = [
	{ domain: "technical_helper", words: ["code", "bug", "debug", "api", "function", "test", "error", "build", "deploy", "database", "git"] },
	{ domain: "creative_writer", words: ["write", "story", "poem", "draft", "creative", "character", "plot", "blog"] },
	{ domain: "emotional_support", words: ["feel", "felt", "sad", "happy", "anxious", "worried", "stressed", "relationship", "proud"] },
	{ domain: "learning_companion", words: ["learn", "understand", "explain", "study", "course", "teach", "curious"] },
	{ domain: "planning_partner", words: ["plan", "schedule", "deadline", "roadmap", "goal", "organize", "prioritize"] },
	{ domain: "research_aide", words: ["research", "paper", "source", "compare", "analysis", "data", "evidence"] },
];

export class HeuristicEngine implements CognitiveEngine {
	readonly name = "heuristic";

	async think(prompt: string, _opts?: ThinkOptions): Promise<string> {
		return this.thinkSync(prompt);
	}

	/** Synchronous analysis — used as the deterministic fallback inside the pipeline. */
	thinkSync(prompt: string): string {
		const task = taskOf(prompt);
		const { user, agent, text } = subjectOf(prompt);
		const combined = `${user}\n${agent}`.trim() || text;

		switch (task) {
			case "sentiment": {
				return JSON.stringify(heuristicSentiment(combined));
			}
			case "significance": {
				const s = heuristicSentiment(combined);
				const tokens = tokenize(combined);
				const novelty = clamp(tokens.length / 60 + (text.length > 200 ? 0.2 : 0), 0, 1);
				const emotional_intensity = clamp(Math.abs(s.valence) + s.arousal, 0, 1);
				const goal_relevance = clamp(
					/\b(need|must|important|project|deadline|goal|prefer|always|never)\b/i.test(combined) ? 0.7 : 0.3,
					0,
					1,
				);
				return JSON.stringify({
					novelty,
					emotional_intensity,
					goal_relevance,
					content_richness: contentRichness(combined),
				});
			}
			case "facts": {
				const facts: Array<{ content: string; entities: string[]; importance: number }> = [];
				for (const pattern of FACT_PATTERNS) {
					for (const m of combined.matchAll(pattern.re)) {
						const content = pattern.build(m);
						const ents = keywords(content, 4);
						const importance = clamp(4 + Math.round(heuristicSentiment(content).arousal * 4), 1, 10);
						facts.push({ content, entities: ents, importance });
					}
				}
				return JSON.stringify({ facts: facts.slice(0, 8) });
			}
			case "entities": {
				const found = new Map<string, string>();
				// Capitalized multi-word spans + known tool-ish tokens.
				for (const m of text.matchAll(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+){0,2})\b/g)) {
					const name = m[1]!.trim();
					if (["The", "This", "That", "USER", "AGENT", "TEXT", "TASK"].includes(name)) continue;
					if (!found.has(name)) found.set(name, guessEntityType(name));
				}
				for (const token of tokenize(text)) {
					if (["rust", "python", "typescript", "graphql", "kubernetes", "react"].includes(token)) {
						found.set(token, "topic");
					}
				}
				return JSON.stringify({
					entities: [...found.entries()].slice(0, 12).map(([name, entity_type]) => ({ name, entity_type })),
				});
			}
			case "self_model": {
				const lower = text.toLowerCase();
				const domains: Array<{ domain: string; evidence_delta: number }> = [];
				for (const hint of DOMAIN_HINTS) {
					const hits = hint.words.filter((w) => lower.includes(w)).length;
					if (hits > 0) domains.push({ domain: hint.domain, evidence_delta: clamp(hits, 1, 3) });
				}
				return JSON.stringify({ domains });
			}
			case "reflect": {
				const ks = keywords(text, 6);
				return JSON.stringify({
					themes: ks.slice(0, 3),
					patterns: ks.slice(3, 5),
					summary: text.split("\n").slice(0, 3).join(" ").slice(0, 400),
					corrections: [],
				});
			}
			case "learn": {
				return JSON.stringify({ events: [] });
			}
			default:
				return "HeuristicEngine has no model of free-form thought. Use a CognitiveEngine with an LLM for reflection.";
		}
	}
}

function guessEntityType(name: string): string {
	const lower = name.toLowerCase();
	if (["rust", "python", "typescript", "graphql", "kubernetes", "react", "claude", "pi"].includes(lower)) return "topic";
	if (["acme", "corp", "inc", "ltd", "labs"].some((w) => lower.includes(w))) return "organization";
	if (["monday", "tuesday", "january", "february"].includes(lower)) return "time";
	return /^[A-Z][a-z]+$/.test(name) ? "person" : "topic";
}
