// Fireflies.ai GraphQL client — fetch transcripts
// Requires: FIREFLIES_API_KEY env var

const FIREFLIES_API = "https://api.fireflies.ai/graphql";

export interface FirefliesSentence {
  speaker_name: string;
  text: string;
  raw_text: string;
  start_time: number | string;
  end_time: number | string;
  sentiment: string;
  ai_filters: {
    task: boolean;
    pricing: boolean;
    metric: boolean;
    question: boolean;
  };
}

export interface FirefliesSpeaker {
  id: string;
  name: string;
}

export interface FirefliesTranscript {
  id: string;
  title: string;
  date: number; // unix timestamp ms
  duration: number; // minutes (per Fireflies API docs)
  organizer_email: string;
  participants: string[];
  speakers: FirefliesSpeaker[];
  sentences: FirefliesSentence[];
  summary: {
    action_items: string[];
    keywords: string[];
    overview: string;
    shorthand_bullet: string[];
  };
}

export interface FirefliesListItem {
  id: string;
  title: string;
  date: number;
  duration: number;
  organizer_email: string;
  participants: string[];
}

async function graphql<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(FIREFLIES_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Fireflies API error ${response.status}: ${text}`);
  }

  const json = await response.json();
  if (json.errors) {
    throw new Error(`Fireflies GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

export async function fetchTranscript(apiKey: string, transcriptId: string): Promise<FirefliesTranscript> {
  const data = await graphql<{ transcript: FirefliesTranscript }>(apiKey, `
    query Transcript($id: String!) {
      transcript(id: $id) {
        id
        title
        date
        duration
        organizer_email
        participants
        speakers {
          id
          name
        }
        sentences {
          speaker_name
          text
          raw_text
          start_time
          end_time
          sentiment
          ai_filters {
            task
            pricing
            metric
            question
          }
        }
        summary {
          action_items
          keywords
          overview
          shorthand_bullet
        }
      }
    }
  `, { id: transcriptId });

  return data.transcript;
}

export async function listRecentTranscripts(apiKey: string, limit = 20): Promise<FirefliesListItem[]> {
  const data = await graphql<{ transcripts: FirefliesListItem[] }>(apiKey, `
    query RecentTranscripts($limit: Int) {
      transcripts(limit: $limit) {
        id
        title
        date
        duration
        organizer_email
        participants
      }
    }
  `, { limit });

  return data.transcripts;
}
