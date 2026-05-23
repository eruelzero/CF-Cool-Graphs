# CF Cool Graphs

An interactive profile visualization and statistics dashboard for Codeforces competitive programming.

## Features
- **Rating Dynamics**: View official rating changes and maximum solved problem difficulties.
- **Performance History**: Track official vs. virtual contest performance ratings.
- **Rolling Solve averages**: Rolling average ratings across your last 50 solves.
- **Tag Difficulty Trends**: Tag-specific rolling averages (15 solves) to see where you are improving.
- **Verdict Distributions**: Detailed verdict breakdowns by rating and tags.
- **Solve Activity**: Solved problems heatmap and time-of-day radar dodecagon chart mapped to your local timezone.
- **Skill Weakness Map**: Plot tag accuracy against average difficulty gap to identify your next practice targets.
- **Upsolve Tracker**: Cumulative upsolve progression line (on actual practice solve dates) and a focused pending checklist (exactly 1 unresolved problem per contest).

## Development
- **Frontend**: HTML5, Vanilla CSS, Vanilla JS, and Chart.js.
- **Backend**: Express, Node.js.
- **Database**: MongoDB for request caching.
- **Hosting**: Configured for Vercel Serverless Functions.
