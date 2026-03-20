// Map Fireflies meetings to Design Space projects
// Uses regex rules on meeting title and participant emails

import type { FirefliesTranscript } from "./fetch-transcript.ts";

interface MappingRule {
  titlePattern?: string;
  participantEmail?: string;
  project: string;
}

interface ProjectMapConfig {
  rules: MappingRule[];
  default: string | null;
}

export function loadProjectMap(): ProjectMapConfig {
  const raw = Deno.env.get("FIREFLIES_PROJECT_MAP");
  if (!raw) return { rules: [], default: null };

  try {
    return JSON.parse(raw);
  } catch {
    console.warn("Invalid FIREFLIES_PROJECT_MAP JSON, using defaults");
    return { rules: [], default: null };
  }
}

export function mapToProject(transcript: FirefliesTranscript, config?: ProjectMapConfig): string | null {
  const map = config ?? loadProjectMap();

  for (const rule of map.rules) {
    if (rule.titlePattern) {
      const regex = new RegExp(rule.titlePattern, "i");
      if (regex.test(transcript.title)) {
        return rule.project;
      }
    }

    if (rule.participantEmail) {
      const email = rule.participantEmail.toLowerCase();
      if (transcript.participants?.some(p => p.toLowerCase() === email)) {
        return rule.project;
      }
      if (transcript.organizer_email?.toLowerCase() === email) {
        return rule.project;
      }
    }
  }

  return map.default;
}
