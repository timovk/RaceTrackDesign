/**
 * Marshal posts, following FIA Appendix H (2026) article 2.4.2: no part of
 * the track may escape observation, each post must see the previous and the
 * next one, and consecutive posts may be at most 500 m apart.
 *
 * Posts stand beside the track on the outside of the next corner. Sight
 * lines are traced over the terrain, so hills and crests between posts
 * count. Placement is greedy: from each post, the next one goes as far
 * ahead as the rules allow.
 */
import type { HeightSampler, Track } from './track.ts';

export interface MarshalPost {
  /** Post number, counted from the first post after the start line. */
  number: number;
  station: number;
  x: number;
  y: number;
  /** +1 left of the direction of travel, -1 right. */
  side: 1 | -1;
}

export interface MarshalPlan {
  posts: MarshalPost[];
  /** Largest distance along the track between consecutive posts, in metres. */
  maxGap: number;
  /** Metres of track that no post can see. */
  unobserved: number;
  /** Every post can see the next one. */
  allLinked: boolean;
}

export const MAX_POST_SPACING = 500;
const EYE_HEIGHT = 1.7;
/** Posts stand this far outside the track edge. */
const POST_OFFSET = 6;
const CANDIDATE_STEP = 20;
const SIGHT_STEP = 5;

export function placeMarshalPosts(t: Track, heightAt: HeightSampler): MarshalPlan {
  const { n, ds } = t;
  const sideAt = outsideSides(t);
  const postAt = (k: number) => {
    const side = sideAt[k];
    const off = t.width[k] / 2 + POST_OFFSET;
    const x = t.x[k] + Math.sin(t.heading[k]) * side * off;
    const y = t.y[k] - Math.cos(t.heading[k]) * side * off;
    return { station: k, x, y, side: (side > 0 ? 1 : -1) as 1 | -1, eye: Math.max(heightAt(x, y), t.z[k]) + EYE_HEIGHT };
  };
  type Spot = ReturnType<typeof postAt>;
  const sees = (a: { x: number; y: number; eye: number }, bx: number, by: number, bz: number) => {
    const d = Math.hypot(bx - a.x, by - a.y);
    const steps = Math.max(1, Math.ceil(d / SIGHT_STEP));
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      const h = a.eye + (bz - a.eye) * f;
      if (heightAt(a.x + (bx - a.x) * f, a.y + (by - a.y) * f) > h) return false;
    }
    return true;
  };
  const seesPost = (a: Spot, b: Spot) => sees(a, b.x, b.y, b.eye);
  const seesTrack = (a: Spot, k: number) => sees(a, t.x[k], t.y[k], t.z[k] + 0.5);

  const step = Math.max(1, Math.round(CANDIDATE_STEP / ds));
  const maxAhead = Math.floor((MAX_POST_SPACING - 1) / ds);
  const first = Math.round(30 / ds) % n;
  const covered = (a: Spot, b: Spot, span: number) => {
    for (let i = step; i < span; i += step) {
      const k = (a.station + i) % n;
      if (!seesTrack(a, k) && !seesTrack(b, k)) return false;
    }
    return true;
  };
  const posts: Spot[] = [postAt(first)];
  let current = posts[0];
  let travelled = 0;
  for (let guard = 0; guard < 2000; guard++) {
    const remaining = n - travelled;
    // Close the loop once the first post is within reach and in sight, with all track between seen.
    if (remaining <= maxAhead && seesPost(current, posts[0]) && covered(current, posts[0], remaining)) break;
    let chosen: Spot | null = null;
    let fallback: Spot | null = null;
    for (let ahead = Math.min(maxAhead, remaining - step); ahead >= step; ahead -= step) {
      const cand = postAt((current.station + ahead) % n);
      if (!seesPost(current, cand)) continue;
      if (!fallback) fallback = cand;
      if (covered(current, cand, ahead)) {
        chosen = cand;
        break;
      }
    }
    const next = chosen ?? fallback ?? postAt((current.station + Math.min(remaining - step, Math.max(step, Math.round(100 / ds)))) % n);
    const advance = (next.station - current.station + n) % n;
    if (advance <= 0 || advance >= remaining) break;
    travelled += advance;
    posts.push(next);
    current = next;
  }

  // Gaps, links and unobserved track, including the gap from the last post back to the first.
  let maxGap = 0;
  let allLinked = true;
  let blind = 0;
  for (let p = 0; p < posts.length; p++) {
    const a = posts[p];
    const b = posts[(p + 1) % posts.length];
    const gap = ((b.station - a.station + n) % n || n) * ds;
    maxGap = Math.max(maxGap, gap);
    if (posts.length > 1 && !seesPost(a, b)) allLinked = false;
    const span = Math.round(gap / ds);
    for (let i = step; i < span; i += step) {
      const k = (a.station + i) % n;
      if (!seesTrack(a, k) && !seesTrack(b, k)) blind += step * ds;
    }
  }

  return {
    posts: posts.map((p, i) => ({ number: i + 1, station: p.station, x: p.x, y: p.y, side: p.side })),
    maxGap,
    unobserved: blind,
    allLinked,
  };
}

/** For each station, the outside of the next corner within 300 m (left on straights with none). */
function outsideSides(t: Track): Int8Array {
  const { n, ds } = t;
  const out = new Int8Array(n);
  const look = Math.round(300 / ds);
  let nextSign = 0;
  // Walk backwards twice round so each station knows the next significant curvature ahead.
  const dist = new Int32Array(n).fill(1 << 30);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const c = t.curvature[i];
      if (Math.abs(c) > 1 / 300) {
        nextSign = Math.sign(c);
        dist[i] = 0;
      } else if (i < n - 1) {
        dist[i] = Math.min(dist[i], dist[i + 1] + 1);
      } else {
        dist[i] = Math.min(dist[i], dist[0] + 1);
      }
      // A right-hander (positive curvature) has its outside on the left (+1).
      out[i] = dist[i] <= look && nextSign !== 0 ? (nextSign > 0 ? 1 : -1) : 1;
    }
  }
  return out;
}
