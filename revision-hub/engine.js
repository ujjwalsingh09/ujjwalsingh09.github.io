// ─────────────────────────────────────────────────────────────────────────────
// Java Revision Hub — cram engine (pure, dependency-free)
// Ranked by: askProb × roleFit × weakness, budgeted greedy knapsack.
// All derived values recomputed from events — never stored.
// ─────────────────────────────────────────────────────────────────────────────

const SENIORITY_ORDER = ["MID", "SENIOR", "STAFF"];

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// recall: EMA of recent card ratings, 5-day recency half-life. Unknown = 0.5.
function recallScore(events, topicId, now) {
  now = now || new Date();
  const HALF_LIFE_MS = 5 * 24 * 60 * 60 * 1000;
  let num = 0, den = 0;
  for (const e of events) {
    if (e.topicId !== topicId) continue;
    const w = Math.pow(0.5, (now - new Date(e.ts)) / HALF_LIFE_MS);
    num += w * (e.rating / 5);
    den += w;
  }
  return den === 0 ? 0.5 : num / den;
}

// weakness = 1 - recall, boosted by recent fumbles (14-day half-life decay).
function weakness(events, fumbles, topicId, now) {
  now = now || new Date();
  const base = 1 - recallScore(events, topicId, now);
  let boost = 0;
  for (const f of fumbles) {
    if (f.topicId !== topicId) continue;
    boost += 0.15 * Math.pow(0.5, (now - new Date(f.ts)) / (14 * 24 * 60 * 60 * 1000));
  }
  return Math.min(1, base + boost);
}

// role fit: overlap between topic and interview role tags (floor 0.5).
function roleFit(topic, interview) {
  if (!interview.roleTags || interview.roleTags.length === 0) return 1;
  const hits = topic.roleTags.filter((t) => interview.roleTags.includes(t)).length;
  return 0.5 + 0.5 * (hits / interview.roleTags.length);
}

function seniorityOk(topic, target) {
  return SENIORITY_ORDER.indexOf(topic.seniorityMin) <= SENIORITY_ORDER.indexOf(target);
}

// Cram plan: greedy knapsack — 70% depth on weak/high-prob topics, 30% skim,
// then a flashcard sweep. Every item carries a human-readable reason.
function generatePlan(topics, interview, events, fumbles, now) {
  now = now || new Date();
  const scored = topics
    .filter((t) => seniorityOk(t, interview.seniority))
    .map((t) => {
      const w = weakness(events, fumbles, t.id, now);
      const fit = roleFit(t, interview);
      const value = t.askProb * fit * w;
      return { topic: t, weakness: w, fit: fit, value: value, density: value / t.estTimeMin };
    })
    .filter((s) => s.value > 0.02)
    .sort((a, b) => b.density - a.density);

  const items = [];
  let used = 0;
  const depthBudget = interview.prepTimeMin * 0.7;

  for (const s of scored) {
    if (used + s.topic.estTimeMin <= depthBudget) {
      items.push({
        topicId: s.topic.id, activityType: "CHEATSHEET", allocMin: s.topic.estTimeMin,
        reason: "Weak spot (" + Math.round(s.weakness * 100) + "% weakness) + high ask probability — deep revision first",
      });
      used += s.topic.estTimeMin;
    }
  }

  let skimUsed = 0;
  const skimBudget = interview.prepTimeMin - used;
  for (const s of scored) {
    if (skimUsed >= skimBudget) break;
    if (items.some((i) => i.topicId === s.topic.id)) continue;
    const skimMin = Math.min(Math.ceil(s.topic.estTimeMin / 2), skimBudget - skimUsed);
    if (skimMin < 10) break;
    items.push({
      topicId: s.topic.id, activityType: "CHEATSHEET", allocMin: skimMin,
      reason: "Skim only — moderate fit, lower weakness (" + Math.round(s.weakness * 100) + "%)",
    });
    skimUsed += skimMin;
  }

  if (items.length > 0) {
    const remaining = interview.prepTimeMin - used - skimUsed;
    const sweep = Math.min(Math.max(10, Math.round(interview.prepTimeMin * 0.1)), Math.max(remaining, 0));
    if (sweep >= 10) {
      const weakest = items
        .map((i) => ({ i: i, w: weakness(events, fumbles, i.topicId, now) }))
        .sort((a, b) => b.w - a.w)[0];
      items.push({
        topicId: weakest.i.topicId, activityType: "FLASHCARDS", allocMin: sweep,
        reason: "Flashcard sweep over selected topics — active recall beats re-reading",
      });
    }
  }

  items.forEach((i, n) => (i.seq = n + 1));
  const plannedMin = items.reduce((a, i) => a + i.allocMin, 0);
  return { totalMin: interview.prepTimeMin, plannedMin: plannedMin, items: items };
}

// Morning-of gotcha list: recent failures + top ask-prob gotchas only.
function gotchaList(topics, events, fumbles, interview, limit) {
  limit = limit || 12;
  const now = new Date();
  const failed = new Set(events.filter((e) => e.rating < 3).map((e) => e.topicId));
  fumbles.forEach((f) => failed.add(f.topicId));
  return topics
    .filter((t) => failed.has(t.id) || (t.gotchas && t.gotchas.length))
    .map((t) => ({
      topic: t,
      score: t.askProb * roleFit(t, interview) * (failed.has(t.id) ? 2 : 1),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({
      topicId: s.topic.id, activityType: "GOTCHA_LIST",
      allocMin: Math.max(2, Math.round(30 / limit)),
      reason: failed.has(s.topic.id) ? "You failed cards here recently — reread the gotchas only" : "High ask probability — gotcha checklist",
    }));
}

// SM-2 (Anki): interval growth + ease factor updates.
function nextSchedule(prev, rating, now) {
  now = now || new Date();
  const ease = prev ? prev.easeFactor : 2.5;
  let interval = prev ? prev.intervalDays : 0;
  let nextEase = ease;
  if (rating >= 3) {
    interval = interval === 0 ? 1 : Math.round(interval * ease);
    const q = 5 - rating;
    nextEase = clamp(ease + (0.1 - q * (0.08 + q * 0.02)), 1.3, 2.5);
  } else {
    interval = 1;
    nextEase = clamp(ease - 0.2, 1.3, 2.5);
  }
  return {
    intervalDays: interval,
    easeFactor: nextEase,
    nextDue: new Date(now.getTime() + interval * 24 * 60 * 60 * 1000).toISOString(),
  };
}

// Taxonomy navigation (parentId is single source of truth).
function childrenOf(topics, parentId) { return topics.filter((t) => t.parentId === parentId); }
function parentOf(topics, topicId) {
  const p = topics.find((t) => t.id === topicId);
  const pid = p ? p.parentId : null;
  return pid ? topics.find((t) => t.id === pid) || null : null;
}
function ancestorsOf(topics, topicId) {
  const chain = []; let cur = parentOf(topics, topicId);
  while (cur) { chain.unshift(cur); cur = parentOf(topics, cur.id); }
  return chain;
}
function descendantsOf(topics, rootId) {
  const out = [];
  (function walk(pid) {
    for (const c of childrenOf(topics, pid)) { out.push(c); walk(c.id); }
  })(rootId);
  return out;
}

export {
  recallScore, weakness, roleFit, generatePlan, gotchaList, nextSchedule,
  childrenOf, parentOf, ancestorsOf, descendantsOf,
};
