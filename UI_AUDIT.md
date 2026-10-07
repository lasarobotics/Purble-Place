# HazeHub UI audit — October 7, 2026

The TypeScript application is in `frontend/` (Next.js). Root `src/main.jsx` and `server/` belong to a separate legacy Vite/Express app. Vercel and the documented Docker/Azure setup target the Next.js frontend.

## Changes implemented

| Surface | Change |
| --- | --- |
| Scouting | Five sections: Match, Scoring, Endgame, Ratings, Notes. Removed Quick Tags and every step hint. Short labels replace instructional copy. |
| Team details | Removed Haze Intel, tag aggregation, report tag chips, their component, and unused insight/consensus TypeScript types. |
| Navigation | Removed Film and Consensus Radar. Plain text links, smaller sidebar, mobile Menu with all remaining destinations. |
| Routes | Deleted `/film` and `/admin/consensus`; these are no longer shipped pages. |
| All remaining pages | Removed page subtitles and generic empty-state instructions. Trimmed Home, login, admin, picklists, recovery, and diagnostic prose. |
| Visual system | Indigo background, violet selection, condensed uppercase headings, square controls, open sections and hairline separators. |
| Fonts | Open-license Barlow Condensed and Inter bundled locally as WOFF2 (~91 KB total). No Google font request is required to build or view the UI. |
| Submit | Removed the content transform animation that trapped the fixed Submit bar inside the page. |

## Nous reference

Reference: https://nousresearch.com/ (reviewed in Chrome).

Adapted its dark indigo/electric violet palette, narrow display typography, sparse text navigation, negative space, and rectangular controls. Kept the interface focused on the existing scouting workflow. The original field asset, alliance colors, stats, charts, and operational errors remain functional.

Concept comparison: palette, square geometry, plain navigation, five short section labels, large condensed title and fixed submission controls match the intended direction. Intentional adaptations: one shared field with phase/result switches; existing field image; scheduled-team identity; retained System Health; mobile sections stack vertically. No marketing illustrations or explanatory paragraphs were added.

## Live-site version gap

The open Render deployment has a Configure group containing Seasons & Game and Form Builder. This checkout (base commit `3d5c147`) has neither those routes nor that navigation group. It also lacks some newer live features such as Pit Scout and Picklist Meeting. There is no Configure UI left in this checkout to remove.

Before deploying to Render, identify the branch/commit that serves that deployment and port these changes there. In that version, delete the Configure navigation group and its `/admin/seasons` and `/admin/forms` pages, then remove their imports and links. Do not delete season/form data merely to remove the UI.

## Further deletion candidates

1. Consolidate the two frontend stacks. If root Vite/Express is unused, remove `src/`, `server/`, root `index.html`, and their root package dependencies/scripts after checking the deployment entrypoint. Run the current UI from `frontend/`.
2. Retire backend insight/consensus/film endpoints separately after confirming no other client uses them. This change removes their UI and AI requests; it does not remove database fields or historical records.
3. If fewer admin pages are wanted, combine Team Search, Team Rank, Compare and Data Picklist into one Teams workspace. This is a workflow consolidation and needs a clear choice of the primary view.

## Validation

- Production Next.js build and TypeScript validation passed.
- Chrome local preview, desktop at 1419 × 1108 and mobile at 390 × 844.
- Checked page identity, meaningful render, absence of framework error overlay, horizontal overflow and fixed Submit placement.
- Exercised Auto/Missed → field tap → Teleop/Made → field tap → Undo → climb/rating selection → Defense/Failure fields → Submit. Local fixture received both heatmap points, climb L2, driver 5, notes and empty tags. Match advanced from 1 to 2.
- No-show hides the scoring form. Mobile Menu navigates to Picklists and closes.
- API-backed interaction checks used isolated local fixture data, not the live backend. Real backend integration and deployment remain untested.
- Console messages were from installed browser extensions, including Grammarly-injected body attributes during development hydration. No application runtime exception was observed.
- Repository lint is disabled in `next.config.js`; no passing lint claim is made.

The pre-existing edit in `backend/app/routers/scouting.py` was preserved.
