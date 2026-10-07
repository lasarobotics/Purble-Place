# HazeHub UI audit — October 7, 2026

The current design follows the supplied PurpleScout archive, replacing the earlier Nous-inspired styling.

- PurpleScout typography: Trebuchet MS with Arial/sans-serif fallback, charcoal #222 background, plain controls.
- Removed decorative borders, shadows, alliance tints, colored badges and page summaries across the Next.js application.
- Scouting: Match, Scoring, Endgame, Ratings, Notes. Removed Quick Tags, numbered steps and instructional text. Selected controls use neutral gray and bold text.
- Navigation, home, pit scouting, picklists, account, devices, analysis, admin, forms and seasons share the same primitives.
- Removed unused Inter/Barlow font files and font loader. No network font requests.
- Preserved scoring, field mapping, undo, climb, ratings, defense, failure, notes, no-show, confirmations, local queue, receipts, pit forms, betting and picklist workflows. Historical tags remain readable; new scouting submissions keep the compatible empty tags array.
- Fixed next-match team autofill when the same team occupies the same station in consecutive matches.
- Film, Consensus Radar and Configure remain absent from navigation. Existing season/form routes and backend data are retained.

Validation used isolated local API fixtures, never the deployed backend. Desktop and 390×844 mobile checks covered scoring submission/reset, pit submission, confirmation, no-show and mobile navigation. Cross-screen smoke checks verified font, no page summaries, zero card borders and no horizontal overflow. Production static export (all 22 pages) and TypeScript validation passed. Browser extension warnings and a transient Fast Refresh dependency warning were observed during development.

The active app is in frontend/ (Next.js). The separate root Vite/Express app is outside the deployment path inspected for this work.
