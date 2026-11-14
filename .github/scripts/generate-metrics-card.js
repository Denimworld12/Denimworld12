#!/usr/bin/env node
// Generates the profile stats card (github-metrics-dark.svg and
// github-metrics-light.svg) from live GitHub data: streaks, all-time
// contributions, and commit / pull request / issue / star counts.
//
// Runs on Node 20+ with no dependencies. Requires METRICS_TOKEN in the
// environment. The SVGs are embedded in the README through <img>, where GitHub
// strips scripts, external fonts and animation, so the output is static markup
// using only the system font stack.

const fs = require("node:fs");
const path = require("node:path");

const OUTPUT_DIR = path.resolve(__dirname, "..", "..");
const API_URL = "https://api.github.com/graphql";

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

// GitHub's own design tokens, so the card sits naturally in either theme.
const THEMES = {
  dark: {
    background: "#0d1117",
    border: "#30363d",
    text: "#e6edf3",
    muted: "#8b949e",
    accent: "#e3b341",
    divider: "#21262d",
  },
  light: {
    background: "#ffffff",
    border: "#d0d7de",
    text: "#1f2328",
    muted: "#656d76",
    accent: "#9a6700",
    divider: "#d8dee4",
  },
};

const WIDTH = 520;
const HEIGHT = 216;
const LEFT = 24;
const RIGHT = 496;

// Streak row: three equal columns, the middle one holding the ring.
const COLUMN_CENTERS = [103, 260, 417];
const COLUMN_DIVIDERS = [181.5, 338.5];
const RING_CENTER_Y = 58;
const RING_RADIUS = 30;
const FLAME =
  "M0 -9C3.5 -5.5 6.5 -2.5 6.5 2A6.5 6.5 0 0 1 -6.5 2C-6.5 -0.5 -5 -3 -3 -5C-3 -2.5 -1.5 -1 0 -1.5C1.5 -3 1.5 -6 0 -9Z";

const STATS_DIVIDER_Y = 144;
const STATS_VALUE_Y = 176;
const STATS_LABEL_Y = 193;

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const PROFILE_QUERY = `
  query {
    viewer {
      createdAt
      pullRequests { totalCount }
      mergedPullRequests: pullRequests(states: MERGED) { totalCount }
      issues { totalCount }
      repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
        nodes { stargazerCount }
      }
    }
  }`;

// One contributionsCollection per calendar year, because the API caps a
// collection at a one year span. The current year needs an explicit end, or
// the calendar is padded with empty days out to next January.
function contributionsQuery(firstYear, now) {
  const collections = [];
  for (let year = firstYear; year <= now.getUTCFullYear(); year += 1) {
    const to =
      year === now.getUTCFullYear() ? now.toISOString() : `${year}-12-31T23:59:59Z`;
    collections.push(`
      y${year}: contributionsCollection(from: "${year}-01-01T00:00:00Z", to: "${to}") {
        totalCommitContributions
        contributionCalendar {
          weeks { contributionDays { date contributionCount } }
        }
      }`);
  }
  return `query { viewer { ${collections.join("")} } }`;
}

async function graphql(token, query) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-metrics-card",
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed: HTTP ${response.status}`);
  }
  const payload = await response.json();
  if (payload.errors && payload.errors.length > 0) {
    const messages = payload.errors.map((error) => error.message).join("; ");
    throw new Error(`GitHub GraphQL returned errors: ${messages}`);
  }
  return payload.data;
}

// The calendar's last day is "today" in GitHub's own frame of reference, so
// liveness is judged by position in the list rather than the runner's clock.
function currentStreak(days) {
  let last = days.length - 1;
  while (last >= 0 && days[last].contributionCount === 0) last -= 1;
  if (last < 0 || last < days.length - 2) return null; // last active day is before yesterday
  let first = last;
  while (first > 0 && days[first - 1].contributionCount > 0) first -= 1;
  return { length: last - first + 1, start: days[first].date, end: days[last].date };
}

function longestStreak(days) {
  let best = null;
  let first = -1;
  days.forEach((day, index) => {
    if (day.contributionCount === 0) {
      first = -1;
      return;
    }
    if (first < 0) first = index;
    const length = index - first + 1;
    if (!best || length > best.length) {
      best = { length, start: days[first].date, end: day.date };
    }
  });
  return best;
}

function summarize(profile, collections) {
  const byDate = new Map();
  let commits = 0;
  for (const collection of collections) {
    commits += collection.totalCommitContributions;
    for (const week of collection.contributionCalendar.weeks) {
      for (const day of week.contributionDays) byDate.set(day.date, day);
    }
  }
  const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return {
    total: days.reduce((sum, day) => sum + day.contributionCount, 0),
    since: profile.createdAt.slice(0, 10),
    today: days.length > 0 ? days[days.length - 1].date : null,
    current: currentStreak(days),
    longest: longestStreak(days),
    commits,
    pullRequests: profile.pullRequests.totalCount,
    mergedPullRequests: profile.mergedPullRequests.totalCount,
    issues: profile.issues.totalCount,
    stars: profile.repositories.nodes.reduce(
      (sum, repository) => sum + repository.stargazerCount,
      0,
    ),
  };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function formatNumber(value) {
  return value.toLocaleString("en-US");
}

// Dates arrive as YYYY-MM-DD; the year is spelled out only when it differs
// from the year the card was generated in.
function formatDate(date, currentYear) {
  const [year, month, day] = date.split("-").map(Number);
  const short = `${MONTHS[month - 1]} ${day}`;
  return String(year) === currentYear ? short : `${short}, ${year}`;
}

function formatRange(streak, currentYear) {
  if (!streak) return "No active streak";
  if (streak.start === streak.end) return formatDate(streak.start, currentYear);
  return `${formatDate(streak.start, currentYear)} \u2013 ${formatDate(streak.end, currentYear)}`;
}

function renderStreakColumn(x, value, label, range, theme) {
  return [
    `<text x="${x}" y="62" font-size="30" font-weight="800" fill="${theme.text}">${value}</text>`,
    `<text x="${x}" y="86" font-size="12" font-weight="600" fill="${theme.text}">${label}</text>`,
    `<text x="${x}" y="104" font-size="10" fill="${theme.muted}">${escapeXml(range)}</text>`,
  ].join("\n      ");
}

function renderCurrentStreak(x, streak, range, theme) {
  const flameY = RING_CENTER_Y - RING_RADIUS;
  return [
    `<circle cx="${x}" cy="${RING_CENTER_Y}" r="${RING_RADIUS}" fill="none" stroke="${theme.accent}" stroke-width="4"/>`,
    // Break the ring behind the flame.
    `<rect x="${x - 11}" y="${flameY - 6}" width="22" height="12" fill="${theme.background}"/>`,
    `<path transform="translate(${x} ${flameY + 1})" d="${FLAME}" fill="${theme.accent}"/>`,
    `<text x="${x}" y="${RING_CENTER_Y + 10}" font-size="28" font-weight="800" fill="${theme.text}">${streak ? streak.length : 0}</text>`,
    `<text x="${x}" y="110" font-size="12" font-weight="700" fill="${theme.accent}">Current Streak</text>`,
    `<text x="${x}" y="126" font-size="10" fill="${theme.muted}">${escapeXml(range)}</text>`,
  ].join("\n      ");
}

function renderStats(stats, theme) {
  const tiles = [
    ["Commits", stats.commits],
    ["Pull Requests", stats.pullRequests],
    ["Merged PRs", stats.mergedPullRequests],
    ["Issues", stats.issues],
    ["Stars", stats.stars],
  ];
  const step = (RIGHT - LEFT) / tiles.length;
  return tiles
    .map(([label, value], index) => {
      const x = round(LEFT + step * (index + 0.5));
      return [
        `<text x="${x}" y="${STATS_VALUE_Y}" font-size="18" font-weight="800" fill="${theme.text}">${formatNumber(value)}</text>`,
        `<text x="${x}" y="${STATS_LABEL_Y}" font-size="9" font-weight="700" letter-spacing="0.8" fill="${theme.muted}">${label.toUpperCase()}</text>`,
      ].join("\n      ");
    })
    .join("\n      ");
}

function describe(stats) {
  const current = stats.current ? stats.current.length : 0;
  const longest = stats.longest ? stats.longest.length : 0;
  return `GitHub stats: ${current} day current streak, ${longest} day longest streak, ${formatNumber(stats.total)} total contributions, ${formatNumber(stats.commits)} commits, ${formatNumber(stats.pullRequests)} pull requests (${formatNumber(stats.mergedPullRequests)} merged), ${formatNumber(stats.issues)} issues, ${formatNumber(stats.stars)} stars.`;
}

function renderCard(stats, theme) {
  const currentYear = (stats.today || stats.since).slice(0, 4);
  const [left, middle, right] = COLUMN_CENTERS;
  const summary = escapeXml(describe(stats));
  const dividers = COLUMN_DIVIDERS.map(
    (x) => `<line x1="${x}" y1="28" x2="${x}" y2="120" stroke="${theme.divider}"/>`,
  ).join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${summary}">
  <title>${summary}</title>
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="14" fill="${theme.background}" stroke="${theme.border}"/>
  <g font-family="${FONT}" text-anchor="middle">
    ${dividers}
    <g>
      ${renderStreakColumn(left, formatNumber(stats.total), "Total Contributions", `${formatDate(stats.since, currentYear)} \u2013 Present`, theme)}
    </g>
    <g>
      ${renderCurrentStreak(middle, stats.current, formatRange(stats.current, currentYear), theme)}
    </g>
    <g>
      ${renderStreakColumn(right, stats.longest ? stats.longest.length : 0, "Longest Streak", formatRange(stats.longest, currentYear), theme)}
    </g>
    <line x1="${LEFT}" y1="${STATS_DIVIDER_Y}" x2="${RIGHT}" y2="${STATS_DIVIDER_Y}" stroke="${theme.divider}"/>
    <g>
      ${renderStats(stats, theme)}
    </g>
  </g>
</svg>
`;
}

async function main() {
  const token = process.env.METRICS_TOKEN;
  if (!token) throw new Error("METRICS_TOKEN is not set");

  const profile = (await graphql(token, PROFILE_QUERY)).viewer;
  const firstYear = Number(profile.createdAt.slice(0, 4));
  const contributions = await graphql(token, contributionsQuery(firstYear, new Date()));
  const stats = summarize(profile, Object.values(contributions.viewer));

  for (const [variant, theme] of Object.entries(THEMES)) {
    const file = path.join(OUTPUT_DIR, `github-metrics-${variant}.svg`);
    fs.writeFileSync(file, renderCard(stats, theme));
    console.log(`wrote ${path.relative(process.cwd(), file) || file}`);
  }
  console.log(describe(stats));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
