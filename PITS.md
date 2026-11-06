# Pits event sheet

Open **Admin → Pits · event sheet**. Paste a Google Sheets link, choose the two
tab names, adjust column mappings if necessary, then choose **Save & import**.
The saved link can be replaced for every event. The sheet must be readable by
anyone with its link. Private sheets requiring Google sign-in are not supported.

Both tabs use one header row and one row per team/shift or team/match. Rows for
other teams are ignored. Rows stay in sheet order. Use event-local, 24-hour
times and include a date in the time window when the event spans several days.

Default rotation headers:
`Team, Time window, Pit lead, Mechanical, Electrical, Runner, Driver, Focus / handoff`

Default match headers:
`Team, Match, Queue by, On field, Station, Partners`

Team values must be `418` or `436`. Rotation rows require Team and Time window.
Match rows require Team, Match, Queue by and On field. All other columns are
optional. Driver is displayed in the 436 rotation table. Column mappings allow
different header names; arbitrary merged-cell calendars must first be organized
into this row-based structure.

Each import publishes a shared snapshot; it does not continuously read Google.
Press Save & import again after sheet edits. Pits refreshes the shared snapshot
every minute and offers a Refresh button. Failed imports preserve the last
successful snapshot. The published timestamp remains visible, including when
the app serves an offline cached response.

The same importer can run independently from `backend/`:

```sh
python -m app.pits 'https://docs.google.com/spreadsheets/d/YOUR_ID/edit' --rotations-tab 'Pit rotations' --matches-tab 'Match schedule'
```

This prints JSON without changing the published app schedule. Publishing is
admin-only through `POST /api/admin/pits-sheet`; signed-in users read `/api/pits`.
