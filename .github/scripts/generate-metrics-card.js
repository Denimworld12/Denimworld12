#!/usr/bin/env node
// Generates the profile activity card (github-metrics-dark.svg and
// github-metrics-light.svg) from live GitHub data.
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
    ramp: ["#161b22", "#0e4429", "#1a7a3e", "#2ea043", "#56d364"],
    other: "#30363d",
  },
  light: {
    background: "#ffffff",
    border: "#d0d7de",
    text: "#1f2328",
    muted: "#656d76",
    accent: "#9a6700",
    divider: "#d8dee4",
    ramp: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    other: "#d0d7de",
  },
};

const WIDTH = 520;
// 20px of padding below the last legend row, matching the top padding.
const HEIGHT = 240;
const LEFT = 24;
const RIGHT = 496;

const GRID_TOP = 102;
const GRID_COLUMNS = 53;
const CELL = 7;
const ROW_STEP = 9;

const BAR_TOP = 176;
const BAR_WIDTH = RIGHT - LEFT;
// Just under 9px, so the last column ends flush with the dividers and bar.
const COLUMN_STEP = (BAR_WIDTH - CELL) / (GRID_COLUMNS - 1);
const BAR_HEIGHT = 8;
const BAR_LANGUAGES = 8;

const LEGEND_LANGUAGES = 6;
const LEGEND_COLUMNS = [24, 184, 344];
const LEGEND_ROWS = [204, 220];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const CALENDAR_QUERY = `
  query {
    viewer {
      contributionsCollection {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays { date contributionCount weekday }
          }
        }
      }
    }
  }`;

const LANGUAGES_QUERY = `
  query {
    viewer {
      repositories(first: 100, ownerAffiliations: OWNER, isFork: false) {
        nodes {
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
    }
  }`;

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
  if (last < days.length - 2) return 0; // last active day is before yesterday
  let streak = 0;
  for (let i = last; i >= 0 && days[i].contributionCount > 0; i -= 1) streak += 1;
  return streak;
}

function bestStreak(days) {
  let best = 0;
  let run = 0;
  for (const day of days) {
    run = day.contributionCount > 0 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

function mostActiveWeekday(days) {
  const totals = new Array(7).fill(0);
  for (const day of days) totals[day.weekday] += day.contributionCount;
  return WEEKDAYS[totals.indexOf(Math.max(...totals))];
}

function summarizeCalendar(calendar) {
  const days = calendar.weeks.flatMap((week) => week.contributionDays);
  return {
    total: calendar.totalContributions,
    current: currentStreak(days),
    best: bestStreak(days),
    mostActive: mostActiveWeekday(days),
    weeks: calendar.weeks.slice(-GRID_COLUMNS),
  };
}

function summarizeLanguages(repositories) {
  const byName = new Map();
  for (const repository of repositories) {
    for (const edge of repository.languages.edges) {
      const entry = byName.get(edge.node.name) || {
        name: edge.node.name,
        color: edge.node.color,
        size: 0,
      };
      entry.size += edge.size;
      byName.set(edge.node.name, entry);
    }
  }
  const total = [...byName.values()].reduce((sum, entry) => sum + entry.size, 0);
  return [...byName.values()]
    .sort((a, b) => b.size - a.size)
    .map((entry) => ({ ...entry, share: total > 0 ? entry.size / total : 0 }));
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

// GitHub's own bucketing convention for contribution intensity.
function rampStep(count) {
  if (count === 0) return 0;
  if (count <= 3) return 1;
  if (count <= 6) return 2;
  if (count <= 9) return 3;
  return 4;
}

function renderHeatmap(weeks, theme) {
  const cells = [];
  weeks.forEach((week, column) => {
    for (const day of week.contributionDays) {
      const x = round(LEFT + column * COLUMN_STEP);
      const y = GRID_TOP + day.weekday * ROW_STEP;
      const fill = theme.ramp[rampStep(day.contributionCount)];
      cells.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="1.5" fill="${fill}"/>`,
      );
    }
  });
  return cells.join("\n    ");
}

function renderLanguageBar(languages, theme) {
  const top = languages.slice(0, BAR_LANGUAGES);
  const segments = top.map((language) => ({
    share: language.share,
    color: language.color || theme.other,
  }));
  const otherShare = languages
    .slice(BAR_LANGUAGES)
    .reduce((sum, language) => sum + language.share, 0);
  if (otherShare > 0) segments.push({ share: otherShare, color: theme.other });

  let offset = 0;
  const rects = segments.map((segment, index) => {
    const width = segment.share * BAR_WIDTH;
    const isLast = index === segments.length - 1;
    // Leave a 1px seam between neighbours.
    const drawn = isLast ? width : Math.max(width - 1, 0.5);
    const rect = `<rect x="${round(LEFT + offset)}" y="${BAR_TOP}" width="${round(drawn)}" height="${BAR_HEIGHT}" fill="${escapeXml(segment.color)}"/>`;
    offset += width;
    return rect;
  });
  return rects.join("\n    ");
}

function renderLegend(languages, theme) {
  return languages
    .slice(0, LEGEND_LANGUAGES)
    .map((language, index) => {
      const x = LEGEND_COLUMNS[index % LEGEND_COLUMNS.length];
      const y = LEGEND_ROWS[Math.floor(index / LEGEND_COLUMNS.length)];
      const color = escapeXml(language.color || theme.other);
      const label = `${escapeXml(language.name)} ${(language.share * 100).toFixed(1)}%`;
      return [
        `<rect x="${x}" y="${y - 8}" width="8" height="8" rx="2" fill="${color}"/>`,
        `<text x="${x + 13}" y="${y}" font-size="9" fill="${theme.muted}">${label}</text>`,
      ].join("\n    ");
    })
    .join("\n    ");
}

function renderCard(stats, languages, theme) {
  const total = stats.total.toLocaleString("en-US");
  const label = `font-size="9" font-weight="700" letter-spacing="1" fill="${theme.muted}"`;
  const suffix = `<tspan font-size="11" font-weight="400" fill="${theme.muted}"> day streak</tspan>`;
  const summary = `Activity snapshot: ${stats.current} day current streak, ${stats.best} day best streak in the last year, most active on ${stats.mostActive}, ${total} contributions in the last year.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="${escapeXml(summary)}">
  <title>${escapeXml(summary)}</title>
  <defs>
    <clipPath id="language-bar">
      <rect x="${LEFT}" y="${BAR_TOP}" width="${BAR_WIDTH}" height="${BAR_HEIGHT}" rx="4"/>
    </clipPath>
  </defs>
  <rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${HEIGHT - 1}" rx="14" fill="${theme.background}" stroke="${theme.border}"/>
  <g font-family="${FONT}">
    <text x="24" y="42" font-size="32" font-weight="800" fill="${theme.accent}">${stats.current}${suffix}</text>
    <text x="24" y="56" ${label}>CURRENT STREAK</text>
    <text x="196" y="42" font-size="32" font-weight="800" fill="${theme.text}">${stats.best}${suffix}</text>
    <text x="196" y="56" ${label}>BEST STREAK (1Y)</text>
    <text x="368" y="42" font-size="24" font-weight="800" fill="${theme.text}">${stats.mostActive}</text>
    <text x="368" y="56" ${label}>MOST ACTIVE DAY</text>
    <line x1="${LEFT}" y1="74" x2="${RIGHT}" y2="74" stroke="${theme.divider}"/>

    <text x="${LEFT}" y="92" font-size="10" font-weight="700" letter-spacing="1" fill="${theme.muted}">${total} CONTRIBUTIONS IN THE LAST YEAR</text>
    ${renderHeatmap(stats.weeks, theme)}

    <g clip-path="url(#language-bar)">
    ${renderLanguageBar(languages, theme)}
    </g>
    ${renderLegend(languages, theme)}
  </g>
</svg>
`;
}

async function main() {
  const token = process.env.METRICS_TOKEN;
  if (!token) throw new Error("METRICS_TOKEN is not set");

  const [calendarData, languageData] = await Promise.all([
    graphql(token, CALENDAR_QUERY),
    graphql(token, LANGUAGES_QUERY),
  ]);

  const stats = summarizeCalendar(
    calendarData.viewer.contributionsCollection.contributionCalendar,
  );
  const languages = summarizeLanguages(languageData.viewer.repositories.nodes);

  for (const [variant, theme] of Object.entries(THEMES)) {
    const file = path.join(OUTPUT_DIR, `github-metrics-${variant}.svg`);
    fs.writeFileSync(file, renderCard(stats, languages, theme));
    console.log(`wrote ${path.relative(process.cwd(), file) || file}`);
  }
  console.log(
    `streak ${stats.current} current / ${stats.best} best, most active ${stats.mostActive}, ${stats.total} contributions, ${languages.length} languages`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
