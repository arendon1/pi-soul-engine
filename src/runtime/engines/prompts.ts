/**
 * Task-tagged prompt templates for memory cognition (ported from the reference
 * runtime's cognitive prompt templates). Every prompt starts with
 * `TASK: <name>` so the HeuristicEngine can answer deterministically, and any
 * LLM engine knows exactly what is being asked and in what JSON shape.
 */

export type EngineTask =
	| "sentiment"
	| "significance"
	| "facts"
	| "entities"
	| "self_model"
	| "reflect"
	| "learn";

export function sentimentPrompt(userInput: string, agentOutput: string): string {
	return `TASK: sentiment
Analyze the emotional content of this exchange as a somatic marker.
Return JSON: {"valence": -1..1, "arousal": 0..1, "label": "one-word emotion label"}

USER: ${userInput}
AGENT: ${agentOutput}`;
}

export function significancePrompt(userInput: string, agentOutput: string): string {
	return `TASK: significance
Assess how memorable this exchange is (LIDA significance gate).
Return JSON: {"novelty": 0..1, "emotional_intensity": 0..1, "goal_relevance": 0..1, "content_richness": 0..1}

USER: ${userInput}
AGENT: ${agentOutput}`;
}

export function factsPrompt(userInput: string, agentOutput: string): string {
	return `TASK: facts
Extract durable facts about the human and their context from this exchange.
Each fact is a standalone sentence in third person. Only extract facts that are
likely to remain true and be useful later. Return JSON:
{"facts": [{"content": "…", "entities": ["…"], "importance": 1..10}]}

USER: ${userInput}
AGENT: ${agentOutput}`;
}

export function entitiesPrompt(text: string): string {
	return `TASK: entities
Extract named entities and their types (person, topic, place, organization, project, tool).
Return JSON: {"entities": [{"name": "…", "entity_type": "…"}]}

TEXT: ${text}`;
}

export function selfModelPrompt(domains: string[], text: string): string {
	return `TASK: self_model
This exchange is evidence about what kind of companion I am becoming.
Existing self-concept domains: ${domains.join(", ") || "(none yet)"}
Return JSON: {"domains": [{"domain": "snake_case_domain", "evidence_delta": 1..3}]}
Only report domains this exchange gives real evidence for.

TEXT: ${text}`;
}

export function extractionPrompt(userInput: string, agentOutput: string): string {
	return `TASK: facts
Extract durable facts about the human AND the named entities from this exchange.
Facts are standalone third-person sentences likely to stay true and be useful later.
Return JSON: {"facts": [{"content": "…", "entities": ["…"], "importance": 1..10}], "entities": [{"name": "…", "entity_type": "person|topic|place|organization|project|tool"}]}

USER: ${userInput}
AGENT: ${agentOutput}`;
}

export function reflectPrompt(transcript: string, knownFacts: string[]): string {
	return `TASK: reflect
Consolidate this session's interactions into durable understanding.
Known facts: ${knownFacts.join("; ") || "(none)"}
Return JSON: {"themes": ["…"], "patterns": ["…"], "summary": "…", "corrections": [{"old": "…", "new": "…"}]}

TRANSCRIPT:
${transcript}`;
}

export function learnPrompt(userInput: string, agentOutput: string): string {
	return `TASK: learn
What was learned from this exchange (not what happened): a transferable lesson.
Return JSON: {"events": [{"lesson": "…", "domain": "snake_case", "confidence": 0..1}]}

USER: ${userInput}
AGENT: ${agentOutput}`;
}

/**
 * Dream synthesis: turn detected clusters/procedures/trends into better
 * procedure wording and personality-drift insights.
 */
export function synthesisPrompt(
	clusters: Array<{ topic: string; episode_count: number; representative_content: string }>,
	procedures: Array<{ description: string; frequency: number; confidence: number }>,
	trends: string[],
): string {
	const clusterLines = clusters.slice(0, 8).map((c) => `- ${c.topic} (${c.episode_count}x): ${c.representative_content.slice(0, 120)}`);
	const procedureLines = procedures.slice(0, 8).map((p) => `- ${p.description} (${p.frequency}x, confidence ${p.confidence.toFixed(2)})`);
	return `TASK: dream
You are consolidating a companion's accumulated experience, as happens during sleep.
Rewrite each recurring pattern as a clear, actionable procedural lesson ("when X, do Y"), and note at most 3 personality drifts the evidence supports.
Return JSON: {"procedures": [{"description": "…"}], "insights": [{"trait": "personality.openness|personality.conscientiousness|personality.extraversion|personality.neuroticism|personality.agreeableness", "direction": "increase|decrease", "evidence": "…", "magnitude": 0..0.05}]}
Return exactly ${procedures.length} procedure(s), in the same order.

TOPIC CLUSTERS:\n${clusterLines.join("\n") || "- none"}

DETECTED PATTERNS:\n${procedureLines.join("\n") || "- none"}

BEHAVIORAL TRENDS:\n${trends.map((t) => `- ${t}`).join("\n") || "- none"}`;
}
