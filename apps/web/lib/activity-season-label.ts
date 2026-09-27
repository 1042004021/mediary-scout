// Client-safe, pure season-label helpers. This module MUST have ZERO runtime
// imports — only `import type` — so it can be value-imported from a "use client"
// component without dragging the server runtime (and transitively the `pg`
// Postgres driver) into the browser bundle. `activity-view.ts` re-exports these
// for server-side callers; the activity-feed client component imports them here.
import type { EpisodeState, MediaType, WorkflowKind } from "@media-track/workflow";

/**
 * Distinct, sorted (numeric) season numbers present in an episode set, derived
 * from each episode's `SxxExx` code (EpisodeState carries no explicit season).
 * A whole-show ("全季") run has episodes across many seasons even though its
 * `season.seasonNumber` is a single placeholder → this exposes the real span.
 * Pure + defensive: episodes with an unparseable code are skipped.
 */
export function distinctSeasons(episodes: readonly EpisodeState[]): number[] {
  const seasons = new Set<number>();
  for (const episode of episodes) {
    const match = /^S(\d{2,})E\d{2,}$/.exec(episode.episodeCode);
    if (match) {
      seasons.add(Number(match[1]));
    }
  }
  return Array.from(seasons).sort((a, b) => a - b);
}

/**
 * The season label for an active-run card. Movies and season-less runs → "".
 * One season → "第 N 季"; several → "第 1/2/3/4 季". Prefers the covered-season
 * list; falls back to the single `seasonNumber` when the list is empty. Pure.
 */
export function seasonLabelText(
  type: MediaType,
  seasonNumbers: readonly number[],
  seasonNumber: number | null,
): string {
  if (type === "movie") {
    return "";
  }
  const seasons = seasonNumbers.length > 0 ? seasonNumbers : seasonNumber === null ? [] : [seasonNumber];
  if (seasons.length === 0) {
    return "";
  }
  return `第 ${seasons.join("/")} 季`;
}

/**
 * The sub-label beside an active run's title. A replace run (a user's 「换一个」, or the
 * patrol looking for 待换 episodes) is about the title: it covers every tracked season,
 * whichever one its title lock sits on, so it reads 「换源」 rather than a season. Any
 * other run reads its seasons (seasonLabelText). Pure.
 */
export function activeRunLabel(run: {
  kind: WorkflowKind;
  type: MediaType;
  seasonNumbers: readonly number[];
  seasonNumber: number | null;
}): string {
  return run.kind === "replace_request" ? "换源" : seasonLabelText(run.type, run.seasonNumbers, run.seasonNumber);
}
