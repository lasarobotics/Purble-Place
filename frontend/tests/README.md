# Scouting and analysis checks

Run `npm run build`, `npx playwright install chromium`, then `npm run test:e2e`
from `frontend`. The tests start the production Next.js server on port 3157
and intercept API calls with deterministic fixtures; they never write live data.

Coverage includes cloud snapshot reuse across metrics, formula tooltips, a real
browser offline reload, draft recovery, custom key persistence and collision
validation, mid-match key locking, replay-safe queue sync, updated analysis on
reconnect, heatmap filtering and expansion, point interaction, and mobile overflow.
Screenshots are written to the ignored `test-results` directory.
