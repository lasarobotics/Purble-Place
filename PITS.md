# Pits sheet format

In Admin → Pits · event sheet, paste a Google Sheets link and enter the pit tab name. Allow anyone with the link to view. Save & import publishes a snapshot; repeat after editing the sheet.

## Your wide roster is supported

Use Matches (or Time), 418 Pit Lead, 418 Pit, 436 Pit Lead, and 436 Pit headers. They can follow blank rows. Duplicate Mentor columns and unrelated columns are allowed.

- Pit Lead maps to LEAD.
- Names in each Pit cell fill slots 1–5, in order. Separate them with commas, slashes, semicolons, or line breaks. Missing slots show a dash.
- Alternatively, use columns 418 Pit 1 through 418 Pit 5, and equivalent columns for 436.
- Blank rows, repeated headers, and day dividers such as Sunday are supported. Day labels appear alongside each match range.
- Mentor, Strategy, Scouting, and 9999 columns are ignored; their names are not assigned to pit slots.
- More than five names in one Pit cell produces an error rather than silently dropping people.

Example: Akhil under 418 Pit Lead and Miles under 418 Pit produces LEAD = Akhil, 1 = Miles, with 2–5 empty. Put Miles / Sam / Tai in the Pit cell to populate slots 1–3.

## Optional individual match schedule

The rotation ranges do not specify individual match times or alliances. Leave Match schedule tab blank for rotations only, or supply a separate tab with:

Team, Match, Queue by, On field, Station, Partners

Team is 418 or 436. Team, Match, Queue by and On field are required. Times remain as provided. Header mappings are editable in Admin.

The alternative row-per-team rotation format remains supported:
Team, Time window, LEAD, 1, 2, 3, 4, 5

Failed imports preserve the previous snapshot. A blank match-tab setting publishes an empty match schedule. Pits refreshes the snapshot every minute and offers a Refresh button.

Standalone importer, from backend/:

    python -m app.pits SHEET_URL --rotations-tab "Pit rotations"

Add --matches-tab "Match schedule" when needed. This prints JSON; publishing remains admin-only in the app.
