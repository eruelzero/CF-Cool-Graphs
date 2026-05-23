import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
app.use(cors({
  exposedHeaders: ['X-Cache-Source']
}));
app.use(express.json());

// Set up paths for serving static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, '../public')));

// Connect to MongoDB Cache Database if MONGODB_URI is provided
let isMongoConnected = false;
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
      console.log('Connected to MongoDB Cache Database');
      isMongoConnected = true;
    })
    .catch((err) => {
      console.error('Failed to connect to MongoDB, using memory cache fallback:', err);
    });
} else {
  console.log('MONGODB_URI not provided. Running in memory-cache-only mode.');
}

// Define Contest Cache Schema (stores participant ratings per contest, optimized for space using frequency mapping)
const contestCacheSchema = new mongoose.Schema({
  contestId: { type: Number, required: true, unique: true, index: true },
  ratings: [{
    rating: { type: Number, required: true },
    count: { type: Number, required: true }
  }],
  lastUpdated: { type: Date, default: Date.now }
});
const ContestCache = mongoose.models.ContestCache || mongoose.model('ContestCache', contestCacheSchema);

// Define User Profile Cache Schema
const userCacheSchema = new mongoose.Schema({
  handle: { type: String, required: true, unique: true, index: true },
  profile: Object,
  ratingHistory: Array,
  solvedProblems: Array,
  performances: [{
    contestId: Number,
    contestName: String,
    rank: Number,
    performance: Number,
    participantType: String, // "OFFICIAL" or "VIRTUAL"
    ratingUpdateTimeSeconds: Number,
    isDateTaken: Boolean
  }],
  totalContestsCount: Number,
  heatmapData: Object,
  ratingBuckets: Array,
  verdictsByRating: Array,
  tagsAc: Array,
  tagsError: Array,
  avgSolveTime: Array,
  activityTime: Array,
  tagWeakness: Array,
  upsolveData: Object,
  rollingAvg: Array,
  rollingTags: Object,
  lastUpdated: { type: Date, default: Date.now, index: { expires: '7d' } }
});
const UserCache = mongoose.models.UserCache || mongoose.model('UserCache', userCacheSchema);

// In-Memory Cache configuration
const memoryCache = new Map();
const MEMORY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

function getFromMemoryCache(handle) {
  const key = handle.toLowerCase();
  if (memoryCache.has(key)) {
    const cached = memoryCache.get(key);
    if (Date.now() - cached.timestamp < MEMORY_CACHE_TTL) {
      console.log(`[Memory Cache] HIT: ${handle}`);
      return cached.data;
    } else {
      console.log(`[Memory Cache] EXPIRED: ${handle}`);
      memoryCache.delete(key);
    }
  }
  return null;
}

function setToMemoryCache(handle, data) {
  const key = handle.toLowerCase();
  memoryCache.set(key, {
    timestamp: Date.now(),
    data
  });
}

// Helper function to sleep/delay execution to satisfy rate limit constraints
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calculates Elo performance rating P using binary search
 * seed(P) = 1 + sum( 1 / (1 + 10^((P - oldRating)/400)) ) = rank
 */
function calculateEloPerformance(ratings, rank) {
  if (!ratings || ratings.length === 0) return null;
  let low = -500;
  let high = 5000;
  
  // Check if ratings array is in the new frequency format [ { rating, count } ] or legacy flat format [ rating ]
  const isFrequencyFormat = (ratings[0] && typeof ratings[0] === 'object' && 'rating' in ratings[0]);

  for (let iter = 0; iter < 50; iter++) {
    const mid = (low + high) / 2;
    let expectedRank = 1;
    if (isFrequencyFormat) {
      for (const item of ratings) {
        expectedRank += item.count / (1 + Math.pow(10, (mid - item.rating) / 400));
      }
    } else {
      for (const r of ratings) {
        expectedRank += 1 / (1 + Math.pow(10, (mid - r) / 400));
      }
    }
    if (expectedRank < rank) {
      high = mid; // rating mid is too high (yielded better expected rank than actual)
    } else {
      low = mid;
    }
  }
  return Math.round((low + high) / 2);
}

/**
 * Fetches required user profile metrics directly from Codeforces API.
 * Requires 2-second delays between individual endpoint calls to prevent 403 rate-limiting issues.
 */
async function fetchFromCodeforces(handle) {
  console.log(`[Codeforces API] Fetching user.info for: ${handle}`);
  const infoUrl = `https://codeforces.com/api/user.info?handles=${encodeURIComponent(handle)}`;
  const infoResponse = await axios.get(infoUrl);
  if (infoResponse.data.status !== "OK") {
    throw new Error(infoResponse.data.comment || "Failed to fetch user info");
  }
  const profile = infoResponse.data.result[0];

  // Wait 2 seconds before next request
  console.log(`[Rate Limiter] Sleeping 2000ms...`);
  await delay(2000);

  console.log(`[Codeforces API] Fetching user.rating for: ${handle}`);
  const ratingUrl = `https://codeforces.com/api/user.rating?handle=${encodeURIComponent(handle)}`;
  let ratingHistory = [];
  try {
    const ratingResponse = await axios.get(ratingUrl);
    if (ratingResponse.data.status === "OK") {
      ratingHistory = ratingResponse.data.result;
    }
  } catch (err) {
    // If rating API fails (e.g. user never did contests), default to empty array instead of failing completely.
    console.warn(`[Codeforces API] Warning: Failed to fetch rating history for ${handle}. Proceeding with empty history.`);
  }

  // Wait 2 seconds before next request
  console.log(`[Rate Limiter] Sleeping 2000ms...`);
  await delay(2000);

  console.log(`[Codeforces API] Fetching user.status for: ${handle} (count=1000000)`);
  const statusUrl = `https://codeforces.com/api/user.status?handle=${encodeURIComponent(handle)}&from=1&count=1000000`;
  const statusResponse = await axios.get(statusUrl);
  if (statusResponse.data.status !== "OK") {
    throw new Error(statusResponse.data.comment || "Failed to fetch user status");
  }
  const submissions = statusResponse.data.result;

  return { profile, ratingHistory, submissions };
}

/* --- Analysis & Pre-Processing Helpers (Ported from Python) --- */

function processHeatmapData(submissions) {
  const dailyMax = {};
  for (const sub of submissions) {
    if (sub.verdict === "OK") {
      const creationTime = sub.creationTimeSeconds;
      if (!creationTime) continue;
      const date = new Date(creationTime * 1000);
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      const prob = sub.problem || {};
      const rating = prob.rating || 0;

      if (dailyMax[dateStr] === undefined) {
        dailyMax[dateStr] = rating;
      } else {
        dailyMax[dateStr] = Math.max(dailyMax[dateStr], rating);
      }
    }
  }
  return dailyMax;
}

function processRollingAvgData(submissions, windowSize = 50) {
  const solved = [];
  for (const sub of submissions) {
    if (sub.verdict === "OK" && sub.problem) {
      const rating = sub.problem.rating;
      const t = sub.creationTimeSeconds;
      if (rating && t && t > 0) {
        solved.push({ t, rating });
      }
    }
  }

  solved.sort((a, b) => a.t - b.t);
  if (solved.length === 0) return [];

  const results = [];
  const window = [];
  for (const item of solved) {
    window.push(item.rating);
    if (window.length > windowSize) {
      window.shift();
    }
    const sum = window.reduce((a, b) => a + b, 0);
    const avgRating = sum / window.length;
    results.push({
      time: item.t,
      avg_rating: avgRating
    });
  }
  return results;
}

function processRollingTagsData(submissions, windowSize = 15, minSolves = 30, topN = 5) {
  const tagsSolved = {};
  for (const sub of submissions) {
    if (sub.verdict === "OK" && sub.problem) {
      const rating = sub.problem.rating;
      const t = sub.creationTimeSeconds;
      const tags = sub.problem.tags;
      if (rating && t && t > 0 && tags && tags.length > 0) {
        for (const tag of tags) {
          if (!tagsSolved[tag]) {
            tagsSolved[tag] = [];
          }
          tagsSolved[tag].push({ t, rating });
        }
      }
    }
  }

  const validTags = {};
  for (const tag in tagsSolved) {
    if (tagsSolved[tag].length >= minSolves) {
      validTags[tag] = tagsSolved[tag];
    }
  }

  const sortedTags = Object.keys(validTags).sort((a, b) => validTags[b].length - validTags[a].length);
  const slicedTags = topN !== null ? sortedTags.slice(0, topN) : sortedTags;

  const results = {};
  for (const tag of slicedTags) {
    const solves = validTags[tag];
    solves.sort((a, b) => a.t - b.t);
    const window = [];
    const tagRolling = [];
    for (const item of solves) {
      window.push(item.rating);
      if (window.length > windowSize) {
        window.shift();
      }
      const sum = window.reduce((a, b) => a + b, 0);
      const avgRating = sum / window.length;
      tagRolling.push({
        time: item.t,
        avg_rating: avgRating
      });
    }
    results[tag] = tagRolling;
  }
  return results;
}

function processRatingBucketsData(submissions) {
  const typePriority = { "CONTESTANT": 3, "OUT_OF_COMPETITION": 3, "VIRTUAL": 2, "PRACTICE": 1 };
  const problems = {};
  for (const sub of submissions) {
    const prob = sub.problem;
    if (!prob) continue;
    const cid = prob.contestId;
    const idx = prob.index;
    if (!cid || !idx) continue;
    const pid = `${cid}-${idx}`;
    const rating = prob.rating;
    if (!rating) continue;

    const verdict = sub.verdict;
    const pType = (sub.author && sub.author.participantType) || "PRACTICE";

    if (!problems[pid]) {
      problems[pid] = { rating, solved: false, solved_type: null, attempted: true };
    }

    if (verdict === "OK") {
      problems[pid].solved = true;
      const currentPriority = typePriority[problems[pid].solved_type] || 0;
      const newPriority = typePriority[pType] || 1;
      if (newPriority > currentPriority) {
        if (newPriority === 3) {
          problems[pid].solved_type = 'Contest';
        } else if (newPriority === 2) {
          problems[pid].solved_type = 'Virtual';
        } else {
          problems[pid].solved_type = 'Practice';
        }
      }
    }
  }

  const buckets = {};
  for (const pid in problems) {
    const info = problems[pid];
    const r = info.rating;
    if (!buckets[r]) {
      buckets[r] = { Contest: 0, Virtual: 0, Practice: 0, attempted: 0, solved: 0 };
    }
    buckets[r].attempted += 1;
    if (info.solved) {
      buckets[r].solved += 1;
      const stype = info.solved_type;
      if (stype) {
        buckets[r][stype] += 1;
      }
    }
  }

  const sortedRatings = Object.keys(buckets).map(Number).sort((a, b) => a - b);
  return sortedRatings.map(r => [r, buckets[r]]);
}

function processAttemptsData(submissions) {
  const buckets = {};
  for (const sub of submissions) {
    const prob = sub.problem;
    if (!prob) continue;
    const rating = prob.rating;
    if (!rating) continue;
    const verdict = sub.verdict;

    if (!buckets[rating]) {
      buckets[rating] = { AC: 0, WA: 0, TLE: 0, MLE: 0, Other: 0, total: 0 };
    }

    buckets[rating].total += 1;
    if (verdict === "OK") {
      buckets[rating].AC += 1;
    } else if (verdict === "WRONG_ANSWER") {
      buckets[rating].WA += 1;
    } else if (verdict === "TIME_LIMIT_EXCEEDED") {
      buckets[rating].TLE += 1;
    } else if (verdict === "MEMORY_LIMIT_EXCEEDED") {
      buckets[rating].MLE += 1;
    } else {
      buckets[rating].Other += 1;
    }
  }

  const filtered = {};
  for (const r in buckets) {
    if (buckets[r].total >= 10) {
      filtered[r] = buckets[r];
    }
  }

  const sortedRatings = Object.keys(filtered).map(Number).sort((a, b) => a - b);
  return sortedRatings.map(r => [r, filtered[r]]);
}

function processAvgTimeData(submissions) {
  const participations = {};

  for (const sub of submissions) {
    const author = sub.author;
    if (!author) continue;
    const pType = author.participantType;
    if (!["CONTESTANT", "VIRTUAL", "OUT_OF_COMPETITION"].includes(pType)) {
      continue;
    }

    const verdict = sub.verdict;
    if (verdict === "OK") {
      const prob = sub.problem;
      if (!prob) continue;
      const cid = prob.contestId;
      const idx = prob.index;
      if (!cid || !idx) continue;
      const pid = `${cid}-${idx}`;

      const rating = prob.rating;
      const timeSecs = sub.relativeTimeSeconds;

      if (rating && timeSecs !== undefined && timeSecs !== null && timeSecs >= 0) {
        const partKey = `${cid}_${pType}`;
        if (!participations[partKey]) {
          participations[partKey] = {};
        }

        if (!participations[partKey][pid]) {
          participations[partKey][pid] = { rating, time_secs: timeSecs };
        } else {
          participations[partKey][pid].time_secs = Math.min(participations[partKey][pid].time_secs, timeSecs);
        }
      }
    }
  }

  const buckets = {};
  for (const partKey in participations) {
    const probs = Object.values(participations[partKey]);
    probs.sort((a, b) => a.time_secs - b.time_secs);
    let lastTime = 0;
    for (const info of probs) {
      const r = info.rating;
      const t = info.time_secs;
      const timeTaken = t - lastTime;
      lastTime = t;

      if (!buckets[r]) {
        buckets[r] = { total_time: 0, count: 0 };
      }
      buckets[r].total_time += timeTaken;
      buckets[r].count += 1;
    }
  }

  const results = [];
  for (const r in buckets) {
    const d = buckets[r];
    if (d.count > 0) {
      const avgTime = d.total_time / d.count;
      results.push([Number(r), avgTime, d.count]);
    }
  }

  results.sort((a, b) => a[0] - b[0]);
  return results;
}

function processTagsAcData(submissions, limit = 15) {
  const typePriority = { "CONTESTANT": 3, "OUT_OF_COMPETITION": 3, "VIRTUAL": 2, "PRACTICE": 1 };
  const problems = {};

  for (const sub of submissions) {
    const prob = sub.problem;
    if (!prob) continue;
    const cid = prob.contestId;
    const idx = prob.index;
    const tags = prob.tags;
    if (!cid || !idx || !tags || tags.length === 0) continue;
    const pid = `${cid}-${idx}`;

    const verdict = sub.verdict;
    const pType = (sub.author && sub.author.participantType) || "PRACTICE";

    if (!problems[pid]) {
      problems[pid] = { tags, solved: false, solved_type: null };
    }

    if (verdict === "OK") {
      problems[pid].solved = true;
      const currentPriority = typePriority[problems[pid].solved_type] || 0;
      const newPriority = typePriority[pType] || 1;
      if (newPriority > currentPriority) {
        if (newPriority === 3) {
          problems[pid].solved_type = 'Contest';
        } else if (newPriority === 2) {
          problems[pid].solved_type = 'Virtual';
        } else {
          problems[pid].solved_type = 'Practice';
        }
      }
    }
  }

  const tagCounts = {};
  for (const pid in problems) {
    const info = problems[pid];
    if (info.solved) {
      for (const tag of info.tags) {
        if (!tagCounts[tag]) {
          tagCounts[tag] = { Contest: 0, Virtual: 0, Practice: 0, solved: 0 };
        }
        tagCounts[tag].solved += 1;
        if (info.solved_type) {
          tagCounts[tag][info.solved_type] += 1;
        }
      }
    }
  }

  const sortedTags = Object.keys(tagCounts).map(tag => [tag, tagCounts[tag]])
    .sort((a, b) => b[1].solved - a[1].solved);

  return limit !== null ? sortedTags.slice(0, limit) : sortedTags;
}

function processTagsErrorData(submissions, limit = 15) {
  const tagCounts = {};
  for (const sub of submissions) {
    const prob = sub.problem;
    if (!prob) continue;
    const tags = prob.tags;
    const verdict = sub.verdict;
    if (!tags || tags.length === 0) continue;

    for (const tag of tags) {
      if (!tagCounts[tag]) {
        tagCounts[tag] = { AC: 0, WA: 0, TLE: 0, MLE: 0, Other: 0, total: 0 };
      }
      tagCounts[tag].total += 1;
      if (verdict === "OK") {
        tagCounts[tag].AC += 1;
      } else if (verdict === "WRONG_ANSWER") {
        tagCounts[tag].WA += 1;
      } else if (verdict === "TIME_LIMIT_EXCEEDED") {
        tagCounts[tag].TLE += 1;
      } else if (verdict === "MEMORY_LIMIT_EXCEEDED") {
        tagCounts[tag].MLE += 1;
      } else {
        tagCounts[tag].Other += 1;
      }
    }
  }

  const filtered = [];
  for (const tag in tagCounts) {
    if (tagCounts[tag].total >= 10) {
      filtered.push([tag, tagCounts[tag]]);
    }
  }

  const getAcRate = (item) => {
    const total = item[1].total;
    return total > 0 ? item[1].AC / total : 0;
  };

  filtered.sort((a, b) => getAcRate(b) - getAcRate(a));

  return limit !== null ? filtered.slice(0, limit) : filtered;
}

function processActivityTimeData(submissions) {
  const hourCounts = Array(24).fill(0);
  for (const sub of submissions) {
    if (sub.verdict === "OK") {
      const creationTime = sub.creationTimeSeconds;
      if (creationTime && creationTime > 0) {
        const date = new Date(creationTime * 1000);
        const hour = date.getHours();
        hourCounts[hour]++;
      }
    }
  }
  return hourCounts.map((count, hour) => [hour, count]);
}

function processTagWeaknessData(submissions, ratingHistory, minAttempts = 5) {
  const ratingTimeline = [];
  if (ratingHistory) {
    for (const r of ratingHistory) {
      const t = r.ratingUpdateTimeSeconds;
      const nr = r.newRating;
      if (t && t > 0) {
        ratingTimeline.push({ t, nr });
      }
    }
  }
  ratingTimeline.sort((a, b) => a.t - b.t);

  const getUserRatingAt = (ts) => {
    if (ratingTimeline.length === 0) return null;
    if (ts < ratingTimeline[0].t) return null;
    let lo = 0;
    let hi = ratingTimeline.length - 1;
    let result = ratingTimeline[0].nr;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (ratingTimeline[mid].t <= ts) {
        result = ratingTimeline[mid].nr;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return result;
  };

  const tagStats = {};
  for (const sub of submissions) {
    const prob = sub.problem;
    if (!prob) continue;
    const tags = prob.tags;
    const probRating = prob.rating;
    if (!tags || tags.length === 0 || !probRating) continue;

    const verdict = sub.verdict;
    if (verdict === undefined || verdict === null) continue;

    const creationTime = sub.creationTimeSeconds;
    const userRating = getUserRatingAt(creationTime);
    if (userRating === null) continue;

    const gap = probRating - userRating;

    for (const tag of tags) {
      if (!tagStats[tag]) {
        tagStats[tag] = { ac: 0, total: 0, gap_sum: 0, gap_count: 0 };
      }
      tagStats[tag].total += 1;
      tagStats[tag].gap_sum += gap;
      tagStats[tag].gap_count += 1;
      if (verdict === "OK") {
        tagStats[tag].ac += 1;
      }
    }
  }

  const results = [];
  for (const tag in tagStats) {
    const st = tagStats[tag];
    if (st.total < minAttempts) continue;
    const acRate = st.total > 0 ? (st.ac / st.total) * 100 : 0;
    const avgGap = st.gap_count > 0 ? st.gap_sum / st.gap_count : 0;
    results.push({
      tag,
      ac_rate: acRate,
      avg_gap: avgGap,
      total: st.total,
      ac: st.ac
    });
  }
  return results;
}

function processUpsolveData(submissions) {
  const participations = {};
  const contestProblems = {};
  const problemDetails = {};
  const practiceAcs = new Map(); // Key: `${contestId}_${idx}`, Value: first OK timestamp in seconds

  for (const sub of submissions) {
    const author = sub.author;
    if (!author) continue;
    const pType = author.participantType;
    const prob = sub.problem;
    if (!prob) continue;
    const cid = prob.contestId;
    const idx = prob.index;
    if (!cid || !idx) continue;
    const verdict = sub.verdict;

    // Track all problems submitted to for this contest
    if (!contestProblems[cid]) {
      contestProblems[cid] = new Set();
    }
    contestProblems[cid].add(idx);

    // Track problem details
    const pKey = `${cid}_${idx}`;
    if (!problemDetails[pKey] || (prob.rating && !problemDetails[pKey].rating)) {
      problemDetails[pKey] = {
        name: prob.name || `Problem ${idx}`,
        rating: prob.rating || null
      };
    }

    if (["CONTESTANT", "VIRTUAL", "OUT_OF_COMPETITION"].includes(pType)) {
      if (!participations[cid]) {
        participations[cid] = {
          type: pType === "VIRTUAL" ? "Virtual" : "Official",
          time: sub.creationTimeSeconds || 0,
          solved: new Set()
        };
      }
      if (verdict === "OK") {
        participations[cid].solved.add(idx);
      }
      if (sub.creationTimeSeconds && sub.creationTimeSeconds < participations[cid].time) {
        participations[cid].time = sub.creationTimeSeconds;
      }
    } else if (pType === "PRACTICE") {
      if (verdict === "OK") {
        const timeSecs = sub.creationTimeSeconds;
        if (!practiceAcs.has(pKey) || timeSecs < practiceAcs.get(pKey)) {
          practiceAcs.set(pKey, timeSecs);
        }
      }
    }
  }

  const upsolveHistory = [];
  const pendingChecklist = [];

  for (const cid in participations) {
    const part = participations[cid];
    const allIndices = Array.from(contestProblems[cid] || []).sort();
    const solvedInContest = part.solved;

    // The first unsolved index in sorted order is the single pending problem to upsolve for this contest
    let firstUnsolvedFound = false;

    for (const idx of allIndices) {
      const pKey = `${cid}_${idx}`;
      const details = problemDetails[pKey] || { name: `Problem ${idx}`, rating: null };
      const isSolvedInContest = solvedInContest.has(idx);
      const practiceSolveTime = practiceAcs.get(pKey) || null;

      if (!isSolvedInContest) {
        if (practiceSolveTime !== null) {
          // This was solved in practice (upsolved)
          upsolveHistory.push({
            contestId: Number(cid),
            problemIndex: idx,
            name: details.name,
            rating: details.rating,
            solveTime: practiceSolveTime,
            time: part.time // contest date for historical baseline sorting
          });
        } else if (!firstUnsolvedFound) {
          // This is the FIRST unsolved problem (the wall) that is still pending!
          pendingChecklist.push({
            contestId: Number(cid),
            problemIndex: idx,
            name: details.name,
            rating: details.rating,
            time: part.time
          });
          firstUnsolvedFound = true; // Only show exactly ONE pending problem per contest!
        }
      }
    }
  }

  // Sort chronologically
  upsolveHistory.sort((a, b) => a.solveTime - b.solveTime);
  // Sort pending checklist by contest date descending (latest contests first)
  pendingChecklist.sort((a, b) => b.time - a.time);

  return {
    upsolveHistory,
    pendingChecklist
  };
}

/**
 * Controller to fetch analysis data, checking memory cache and Mongo cache first,
 * and performing data processing/deduplication on API responses.
 */
async function getAnalysisData(handle, forceRefresh = false, calculatePerformances = false) {
  const normHandle = handle.toLowerCase().trim();
  if (!normHandle) {
    throw { status: 400, message: "Handle parameter is required" };
  }

  // Helper function to calculate totalContestsCount from cached data if missing
  const getFallbackTotalContestsCount = (doc) => {
    if (doc.totalContestsCount !== undefined && doc.totalContestsCount !== null) {
      return doc.totalContestsCount;
    }
    const contestIds = new Set();
    if (doc.ratingHistory) {
      doc.ratingHistory.forEach(c => contestIds.add(c.contestId));
    }
    if (doc.solvedProblems) {
      doc.solvedProblems.forEach(p => {
        const cid = parseInt(p.id.split('_')[0], 10);
        if (!isNaN(cid)) contestIds.add(cid);
      });
    }
    return contestIds.size;
  };

  // 1. In-memory cache lookup
  if (!forceRefresh) {
    const memCached = getFromMemoryCache(normHandle);
    if (memCached) {
      const totalCount = getFallbackTotalContestsCount(memCached);
      const isFullyCalculated = memCached.performances && memCached.performances.length >= totalCount;
      const hasNewMetrics = memCached.heatmapData !== undefined;
      const hasMaxSolvedRating = !memCached.ratingHistory || memCached.ratingHistory.length === 0 || memCached.ratingHistory.some(rc => 'maxSolvedRating' in rc);
      const hasVirtualDateTaken = !memCached.performances || memCached.performances.every(p => p.participantType !== 'VIRTUAL' || p.isDateTaken === true);
      const hasNewUpsolveFormat = memCached.upsolveData && !Array.isArray(memCached.upsolveData) && memCached.upsolveData.upsolveHistory !== undefined;
      if (hasNewMetrics && hasMaxSolvedRating && hasVirtualDateTaken && hasNewUpsolveFormat && (!calculatePerformances || isFullyCalculated)) {
        return { data: memCached, source: "memory-cache" };
      }
    }
  }

  // Load existing calculated performances from DB if available (to skip recalculated contests)
  let existingPerformances = [];
  let cachedTotalContestsCount = undefined;
  if (isMongoConnected) {
    try {
      const dbDoc = await UserCache.findOne({ handle: normHandle });
      if (dbDoc) {
        if (dbDoc.performances) {
          existingPerformances = dbDoc.performances;
        }
        cachedTotalContestsCount = dbDoc.totalContestsCount;
      }
    } catch (err) {
      console.error("[MongoDB Cache] Error loading existing performances:", err);
    }
  }

  // 2. MongoDB cache lookup
  if (isMongoConnected && !forceRefresh) {
    try {
      const dbCached = await UserCache.findOne({ handle: normHandle });
      if (dbCached) {
        const totalCount = getFallbackTotalContestsCount(dbCached);
        const isFullyCalculated = dbCached.performances && dbCached.performances.length >= totalCount;
        const hasNewMetrics = dbCached.heatmapData !== undefined;
        const hasMaxSolvedRating = !dbCached.ratingHistory || dbCached.ratingHistory.length === 0 || dbCached.ratingHistory.some(rc => 'maxSolvedRating' in rc);
        
        const hasVirtualDateTaken = !dbCached.performances || dbCached.performances.every(p => p.participantType !== 'VIRTUAL' || p.isDateTaken === true);
        const isVirtualDateValid = hasVirtualDateTaken;
        const hasNewUpsolveFormat = dbCached.upsolveData && !Array.isArray(dbCached.upsolveData) && dbCached.upsolveData.upsolveHistory !== undefined;
        
        const ageMs = Date.now() - new Date(dbCached.lastUpdated).getTime();
        const oneHour = 60 * 60 * 1000;
        if (ageMs < oneHour && hasNewMetrics && hasMaxSolvedRating && isVirtualDateValid && hasNewUpsolveFormat && (!calculatePerformances || isFullyCalculated)) {
          console.log(`[MongoDB Cache] HIT: ${normHandle}`);
          const responseData = {
            profile: dbCached.profile,
            ratingHistory: dbCached.ratingHistory,
            solvedProblems: dbCached.solvedProblems,
            performances: dbCached.performances || [],
            totalContestsCount: totalCount,
            heatmapData: dbCached.heatmapData,
            ratingBuckets: dbCached.ratingBuckets,
            verdictsByRating: dbCached.verdictsByRating,
            tagsAc: dbCached.tagsAc,
            tagsError: dbCached.tagsError,
            avgSolveTime: dbCached.avgSolveTime,
            activityTime: dbCached.activityTime,
            tagWeakness: dbCached.tagWeakness,
            upsolveData: dbCached.upsolveData,
            rollingAvg: dbCached.rollingAvg,
            rollingTags: dbCached.rollingTags
          };
          setToMemoryCache(normHandle, responseData);
          return { data: responseData, source: "mongodb-cache" };
        }
        console.log(`[MongoDB Cache] EXPIRED, missing metrics, or performance calculation required: ${normHandle}`);
      }
    } catch (err) {
      console.error("[MongoDB Cache] Error reading cache:", err);
    }
  }

  // 3. API Query (on Cache Miss or Expired Cache)
  let cfData;
  try {
    cfData = await fetchFromCodeforces(normHandle);
  } catch (err) {
    console.error(`[Codeforces API] Error fetching for '${normHandle}':`, err.message);

    // Fallback: If external API fails, but we have a stale database cache, serve the stale cache.
    if (isMongoConnected) {
      try {
        const staleDbCached = await UserCache.findOne({ handle: normHandle });
        if (staleDbCached) {
          console.log(`[MongoDB Cache] Serving STALE fallback cache for: ${normHandle}`);
          const totalCount = getFallbackTotalContestsCount(staleDbCached);
          const fallbackData = {
            profile: staleDbCached.profile,
            ratingHistory: staleDbCached.ratingHistory,
            solvedProblems: staleDbCached.solvedProblems,
            performances: staleDbCached.performances || [],
            totalContestsCount: totalCount,
            heatmapData: staleDbCached.heatmapData,
            ratingBuckets: staleDbCached.ratingBuckets,
            verdictsByRating: staleDbCached.verdictsByRating,
            tagsAc: staleDbCached.tagsAc,
            tagsError: staleDbCached.tagsError,
            avgSolveTime: staleDbCached.avgSolveTime,
            activityTime: staleDbCached.activityTime,
            tagWeakness: staleDbCached.tagWeakness,
            upsolveData: staleDbCached.upsolveData,
            rollingAvg: staleDbCached.rollingAvg,
            rollingTags: staleDbCached.rollingTags
          };
          setToMemoryCache(normHandle, fallbackData);
          return { data: fallbackData, source: "mongodb-cache-stale-fallback" };
        }
      } catch (dbErr) {
        console.error("[MongoDB Cache] Error reading stale cache fallback:", dbErr);
      }
    }

    // Standardize error messaging & status codes
    if (err.response) {
      const comment = err.response.data?.comment || "";
      if (comment.includes("not found") || err.response.status === 400) {
        throw { status: 404, message: `User '${handle}' not found on Codeforces` };
      }
      throw { status: 502, message: `Codeforces API returned error: ${comment || err.message}` };
    }
    throw { status: 502, message: err.message || "Failed to query Codeforces API" };
  }

  // Group submissions by contestId to find the maximum rating solved IN-CONTEST (excluding PRACTICE solves)
  const inContestMaxRatingMap = new Map();
  const virtualStartTimes = new Map(); // contestId -> earliest virtual start time
  for (const sub of cfData.submissions) {
    if (sub.verdict === "OK" && sub.problem && typeof sub.problem.rating === 'number') {
      const author = sub.author;
      if (author && author.contestId) {
        const type = author.participantType;
        if (type === "CONTESTANT" || type === "OUT_OF_COMPETITION") {
          const cid = author.contestId;
          const rating = sub.problem.rating;
          const currentMax = inContestMaxRatingMap.get(cid) || 0;
          if (rating > currentMax) {
            inContestMaxRatingMap.set(cid, rating);
          }
        }
      }
    }
    
    // Compute earliest virtual participation start time per contest
    const author = sub.author;
    if (author && author.contestId && author.participantType === 'VIRTUAL') {
      const cid = author.contestId;
      const subTime = sub.creationTimeSeconds;
      const relTime = sub.relativeTimeSeconds;
      const startTime = (subTime && relTime !== undefined && relTime !== 2147483647) 
        ? (subTime - relTime) 
        : subTime;
        
      if (startTime) {
        const current = virtualStartTimes.get(cid);
        if (!current || startTime < current) {
          virtualStartTimes.set(cid, startTime);
        }
      }
    }
  }

  // Enrich ratingHistory with maxSolvedRating
  cfData.ratingHistory = cfData.ratingHistory.map(rc => ({
    ...rc,
    maxSolvedRating: inContestMaxRatingMap.get(rc.contestId) || null
  }));

  // 4. Data Processing: Deduplicate submissions by contestId + index (Keep earliest OK submission)
  const uniqueSolvesMap = new Map();
  for (const sub of cfData.submissions) {
    if (sub.verdict === "OK" && sub.problem) {
      const problem = sub.problem;
      const key = `${problem.contestId || 'gym'}_${problem.index || 'unknown'}`;
      const solveTime = sub.creationTimeSeconds;

      const current = uniqueSolvesMap.get(key);
      if (!current || solveTime < current.creationTimeSeconds) {
        uniqueSolvesMap.set(key, {
          id: key,
          name: problem.name,
          rating: problem.rating, // May be undefined
          tags: problem.tags || [],
          creationTimeSeconds: solveTime
        });
      }
    }
  }

  // Sort solved problems chronologically (oldest to newest)
  const solvedProblems = Array.from(uniqueSolvesMap.values()).sort(
    (a, b) => a.creationTimeSeconds - b.creationTimeSeconds
  );

  // 5. Performance Calculations
  // Find all contests user participated in
  const participatedContests = new Map(); // contestId -> { type, contestName, rank, time }
  
  // Scan status submissions for VIRTUAL / OUT_OF_COMPETITION
  for (const sub of cfData.submissions) {
    const author = sub.author;
    if (author && author.contestId) {
      const type = author.participantType;
      if (type === "VIRTUAL") {
        const subTime = sub.creationTimeSeconds;
        const relTime = sub.relativeTimeSeconds;
        const startTime = (subTime && relTime !== undefined && relTime !== 2147483647) 
          ? (subTime - relTime) 
          : subTime;
          
        const existing = participatedContests.get(author.contestId);
        if (!existing || (startTime && startTime < existing.time)) {
          participatedContests.set(author.contestId, {
            type: "VIRTUAL",
            contestName: `Contest ${author.contestId}`,
            rank: null,
            time: startTime || subTime
          });
        }
      } else if (type === "CONTESTANT" || type === "OUT_OF_COMPETITION") {
        participatedContests.set(author.contestId, {
          type: "OFFICIAL",
          contestName: `Contest ${author.contestId}`,
          rank: null,
          time: sub.creationTimeSeconds
        });
      }
    }
  }

  // Merge with official ratingHistory
  for (const c of cfData.ratingHistory) {
    participatedContests.set(c.contestId, {
      type: "OFFICIAL",
      contestName: c.contestName,
      rank: c.rank,
      time: c.ratingUpdateTimeSeconds
    });
  }

  const validExistingPerformances = existingPerformances.filter(p => 
    !(p.participantType === 'VIRTUAL' && (p.rank === 0 || p.rank === null))
  ).map(p => {
    if (p.participantType === 'VIRTUAL') {
      const computedTime = virtualStartTimes.get(p.contestId);
      const isDateTakenVal = p.isDateTaken === true;
      return {
        contestId: p.contestId,
        contestName: p.contestName,
        rank: p.rank,
        performance: p.performance,
        participantType: p.participantType,
        ratingUpdateTimeSeconds: isDateTakenVal ? (computedTime || p.ratingUpdateTimeSeconds) : p.ratingUpdateTimeSeconds,
        isDateTaken: isDateTakenVal
      };
    }
    return p;
  });
  const calculatedMap = new Map(
    validExistingPerformances
      .filter(p => p.participantType !== 'VIRTUAL' || p.isDateTaken === true)
      .map(p => [p.contestId, p])
  );
  const finalPerformancesMap = new Map(validExistingPerformances.map(p => [p.contestId, p]));
  const totalContestsCount = participatedContests.size;
  let newCalculations = 0;
  const MAX_NEW_CALCULATIONS = 3; // Max 3 per request to respect serverless timeouts

  if (calculatePerformances) {
    for (const [contestId, contestInfo] of participatedContests.entries()) {
      if (calculatedMap.has(contestId)) {
        // Keep already calculated performance
        continue;
      }
      if (newCalculations >= MAX_NEW_CALCULATIONS) {
        // Stop calculating to avoid Vercel 10s gateway timeouts. Remaining will calculate on subsequent refreshes.
        break;
      }

      let rank = contestInfo.rank;
      let time = contestInfo.time;
      let contestName = contestInfo.contestName;
      let performance = null;
      let rankSolvedFallbackUsed = false;

      // Fetch virtual rank and start time if not official
      if (rank === null) {
        console.log(`[Incremental Calc] Fetching and calculating rank for virtual contest ${contestId}...`);
        await delay(2000);
        try {
          const standingsUrl = `https://codeforces.com/api/contest.standings?contestId=${contestId}`;
          const standingsRes = await axios.get(standingsUrl);
          if (standingsRes.data.status === "OK") {
            const contest = standingsRes.data.result.contest;
            const problems = standingsRes.data.result.problems;
            const rows = standingsRes.data.result.rows;
            contestName = contest.name || contestName;
            if (contestInfo.type !== 'VIRTUAL') {
              time = contest.startTimeSeconds || time;
            } else {
              time = time || contest.startTimeSeconds;
            }
            const contestType = contest.type; // "CF" or "ICPC"

            // Map problems by index
            const problemMap = new Map();
            problems.forEach(p => {
              problemMap.set(p.index, p);
            });

            // Filter submissions of the user for this virtual contest (exclude practice solves)
            const virtualSubs = cfData.submissions.filter(s => 
              s.contestId === contestId &&
              s.author &&
              s.author.participantType === 'VIRTUAL' &&
              s.relativeTimeSeconds !== 2147483647
            );

            // Group submissions by problem index
            const problemSubmissions = {};
            virtualSubs.forEach(s => {
              const idx = s.problem.index;
              if (idx) {
                if (!problemSubmissions[idx]) {
                  problemSubmissions[idx] = [];
                }
                problemSubmissions[idx].push(s);
              }
            });

            // Dynamically detect penalty multiplier for ICPC style (typically 10 or 20 minutes)
            let penaltyMultiplier = 20;
            if (contestType !== 'CF') {
              for (const row of rows) {
                let sumTimeInMin = 0;
                let totalRejected = 0;
                let hasSolved = false;
                for (const pr of row.problemResults) {
                  if (pr.points > 0 && pr.bestSubmissionTimeSeconds !== undefined) {
                    sumTimeInMin += Math.floor(pr.bestSubmissionTimeSeconds / 60);
                    totalRejected += pr.rejectedAttemptCount;
                    hasSolved = true;
                  }
                }
                if (hasSolved && totalRejected > 0) {
                  const diff = row.penalty - sumTimeInMin;
                  if (diff >= 0 && diff % totalRejected === 0) {
                    const detected = diff / totalRejected;
                    if (detected === 10 || detected === 20) {
                      penaltyMultiplier = detected;
                      break;
                    }
                  }
                }
              }
            }

            let userPoints = 0;
            let userPenalty = 0;
            let userLastAcTime = 0; // in seconds

            for (const idx in problemSubmissions) {
              const subs = problemSubmissions[idx];
              // Sort submissions ascending by relativeTimeSeconds
              subs.sort((a, b) => a.relativeTimeSeconds - b.relativeTimeSeconds);

              let solved = false;
              let firstOkSub = null;
              let rejectedAttempts = 0;

              for (const sub of subs) {
                if (sub.verdict === 'OK') {
                  solved = true;
                  firstOkSub = sub;
                  break;
                } else if (sub.verdict !== 'COMPILATION_ERROR') {
                  rejectedAttempts++;
                }
              }

              if (solved) {
                const prob = problemMap.get(idx);
                if (prob) {
                  const timeInMin = Math.floor(firstOkSub.relativeTimeSeconds / 60);
                  userLastAcTime = Math.max(userLastAcTime, firstOkSub.relativeTimeSeconds);
                  if (contestType === 'CF') {
                    const basePoints = prob.points || 500;
                    let pts = basePoints - timeInMin * (basePoints * 0.004) - 50 * rejectedAttempts;
                    pts = Math.max(pts, basePoints * 0.3);
                    userPoints += pts;
                  } else {
                    // ICPC style or default
                    userPoints += 1;
                    userPenalty += timeInMin + penaltyMultiplier * rejectedAttempts;
                  }
                }
              }
            }

            // Find virtual rank in standings
            let foundRank = null;
            for (const row of rows) {
              const rowPts = row.points;
              const rowPen = row.penalty;

              let userIsBetterOrEqual = false;
              if (contestType === 'CF') {
                if (userPoints > rowPts) {
                  userIsBetterOrEqual = true;
                } else if (Math.abs(userPoints - rowPts) < 1e-9) {
                  // Tie-breaker: last submission time (smaller is better)
                  let rowLastAcTime = 0;
                  for (const pr of row.problemResults) {
                    if (pr.points > 0 && pr.bestSubmissionTimeSeconds !== undefined) {
                      rowLastAcTime = Math.max(rowLastAcTime, pr.bestSubmissionTimeSeconds);
                    }
                  }
                  if (userLastAcTime <= rowLastAcTime) {
                    userIsBetterOrEqual = true;
                  }
                }
              } else {
                if (userPoints > rowPts) {
                  userIsBetterOrEqual = true;
                } else if (userPoints === rowPts) {
                  if (userPenalty <= rowPen) {
                    userIsBetterOrEqual = true;
                  }
                }
              }

              if (userIsBetterOrEqual) {
                foundRank = row.rank;
                break;
              }
            }

            if (foundRank === null) {
              foundRank = rows.length > 0 ? (rows[rows.length - 1].rank + 1) : 1;
            }

            rank = foundRank;
            console.log(`[Incremental Calc] Virtual contest ${contestId} calculated points: ${userPoints}, penalty: ${userPenalty}, determined rank: ${rank}`);
          }
        } catch (err) {
          console.error(`[Incremental Calc] Standings calculation failed for contest ${contestId}:`, err.message);
        }
      }

      if (rank === null || rank === 0) {
        console.log(`[Incremental Calc] Rank is null/0 for contest ${contestId}. Using approximate fallback...`);
        rankSolvedFallbackUsed = true;
      }

      // Fetch rated participants' old ratings
      let ratingsPool = [];
      if (!rankSolvedFallbackUsed) {
        if (isMongoConnected) {
          try {
            const contestCache = await ContestCache.findOne({ contestId });
            if (contestCache) {
              ratingsPool = contestCache.ratings;
            }
          } catch (err) {
            console.error("[Incremental Calc] Error reading ContestCache:", err);
          }
        }

        if (ratingsPool.length === 0) {
          console.log(`[Incremental Calc] Fetching ratingChanges for contest ${contestId}...`);
          await delay(2000);
          try {
            const ratingsUrl = `https://codeforces.com/api/contest.ratingChanges?contestId=${contestId}`;
            const ratingsRes = await axios.get(ratingsUrl);
            if (ratingsRes.data.status === "OK") {
              // Aggregate participant old ratings into frequency map arrays to save space
              const frequencies = {};
              for (const rc of ratingsRes.data.result) {
                if (rc.handle.toLowerCase() !== handle.toLowerCase()) {
                  const r = rc.oldRating;
                  frequencies[r] = (frequencies[r] || 0) + 1;
                }
              }
              ratingsPool = Object.entries(frequencies).map(([rating, count]) => ({
                rating: Number(rating),
                count: count
              }));

              if (isMongoConnected && ratingsPool.length > 0) {
                try {
                  await ContestCache.findOneAndUpdate(
                    { contestId },
                    { ratings: ratingsPool, lastUpdated: new Date() },
                    { upsert: true }
                  );
                } catch (err) {
                  console.error("[Incremental Calc] Error writing ContestCache:", err);
                }
              }
            }
          } catch (err) {
            console.error(`[Incremental Calc] Rating changes fetch failed for contest ${contestId}:`, err.message);
          }
        }
      }

      if (!rankSolvedFallbackUsed && ratingsPool.length > 0 && rank > 0) {
        // Calculate Elo Performance
        performance = calculateEloPerformance(ratingsPool, rank);
      }

      // Fallback approximate calculation if ratings pool could not be retrieved, or rank was null/0, or Elo calculation was null
      if (performance === null) {
        console.log(`[Incremental Calc] Using approximate fallback performance calculation for contest ${contestId}`);
        const contestSolves = cfData.submissions.filter(sub => 
          sub.contestId === contestId &&
          sub.verdict === "OK" &&
          sub.author &&
          ["CONTESTANT", "VIRTUAL", "OUT_OF_COMPETITION"].includes(sub.author.participantType)
        );
        // Deduplicate by index to count unique solved problems in contest
        const uniqueIndices = new Set();
        const solvedRatings = [];
        for (const sub of contestSolves) {
          if (sub.problem && sub.problem.index) {
            if (!uniqueIndices.has(sub.problem.index)) {
              uniqueIndices.add(sub.problem.index);
              if (sub.problem.rating !== undefined) {
                solvedRatings.push(sub.problem.rating);
              }
            }
          }
        }
        if (solvedRatings.length > 0) {
          const rMax = Math.max(...solvedRatings);
          const n = uniqueIndices.size;
          performance = Math.round(rMax + 150 * Math.log(n));
        }
      }

      if (performance === null) {
        performance = 0;
      }

      const perfObj = {
        contestId,
        contestName,
        rank: rank || 0,
        performance,
        participantType: contestInfo.type,
        ratingUpdateTimeSeconds: time,
        isDateTaken: contestInfo.type === 'VIRTUAL' ? true : undefined
      };
      finalPerformancesMap.set(contestId, perfObj);
      calculatedMap.set(contestId, perfObj);
      newCalculations++;
    }
  }

  const performancesList = Array.from(finalPerformancesMap.values());
  // Sort chronologically
  performancesList.sort((a, b) => a.ratingUpdateTimeSeconds - b.ratingUpdateTimeSeconds);

  const aggregatedData = {
    profile: cfData.profile,
    ratingHistory: cfData.ratingHistory,
    solvedProblems: solvedProblems,
    performances: performancesList,
    totalContestsCount: totalContestsCount,
    heatmapData: processHeatmapData(cfData.submissions),
    ratingBuckets: processRatingBucketsData(cfData.submissions),
    verdictsByRating: processAttemptsData(cfData.submissions),
    tagsAc: processTagsAcData(cfData.submissions, 15),
    tagsError: processTagsErrorData(cfData.submissions, 15),
    avgSolveTime: processAvgTimeData(cfData.submissions),
    activityTime: processActivityTimeData(cfData.submissions),
    tagWeakness: processTagWeaknessData(cfData.submissions, cfData.ratingHistory),
    upsolveData: processUpsolveData(cfData.submissions),
    rollingAvg: processRollingAvgData(cfData.submissions, 50),
    rollingTags: processRollingTagsData(cfData.submissions, 15, 30, 5)
  };

  // 6. Update In-memory Cache
  setToMemoryCache(normHandle, aggregatedData);

  // 7. Update MongoDB Cache
  if (isMongoConnected) {
    try {
      await UserCache.findOneAndUpdate(
        { handle: normHandle },
        {
          profile: aggregatedData.profile,
          ratingHistory: aggregatedData.ratingHistory,
          solvedProblems: aggregatedData.solvedProblems,
          performances: aggregatedData.performances,
          totalContestsCount: aggregatedData.totalContestsCount,
          heatmapData: aggregatedData.heatmapData,
          ratingBuckets: aggregatedData.ratingBuckets,
          verdictsByRating: aggregatedData.verdictsByRating,
          tagsAc: aggregatedData.tagsAc,
          tagsError: aggregatedData.tagsError,
          avgSolveTime: aggregatedData.avgSolveTime,
          activityTime: aggregatedData.activityTime,
          tagWeakness: aggregatedData.tagWeakness,
          upsolveData: aggregatedData.upsolveData,
          rollingAvg: aggregatedData.rollingAvg,
          rollingTags: aggregatedData.rollingTags,
          lastUpdated: new Date()
        },
        { upsert: true, new: true }
      );
      console.log(`[MongoDB Cache] Upserted: ${normHandle}`);
    } catch (err) {
      console.error("[MongoDB Cache] Write error:", err);
    }
  }

  return { data: aggregatedData, source: "codeforces-api" };
}

// REST Endpoints
app.get('/api/analysis', async (req, res) => {
  const { handle, calculatePerformances } = req.query;
  if (!handle) {
    return res.status(400).json({ error: "Handle parameter is required" });
  }
  try {
    const result = await getAnalysisData(handle, false, calculatePerformances === 'true');
    res.setHeader('X-Cache-Source', result.source);
    return res.json(result.data);
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || "An unexpected error occurred";
    return res.status(status).json({ error: message });
  }
});

app.post('/api/analysis/refresh', async (req, res) => {
  const { handle, calculatePerformances } = req.query;
  if (!handle) {
    return res.status(400).json({ error: "Handle parameter is required" });
  }
  try {
    const result = await getAnalysisData(handle, true, calculatePerformances === 'true');
    res.setHeader('X-Cache-Source', result.source);
    return res.json(result.data);
  } catch (err) {
    const status = err.status || 500;
    const message = err.message || "An unexpected error occurred";
    return res.status(status).json({ error: message });
  }
});

// Fallback: serve index.html for undefined requests (single page app navigation compatibility)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Export default app for serverless platforms like Vercel
export default app;

// Listen on PORT if running locally or as a persistent server (e.g. Render)
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}
