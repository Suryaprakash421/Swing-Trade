# NSE cash calendar provenance

Reviewed on **2026-10-31** against official NSE Capital Market sources:

- [NSE/CMTR/71775, December 12, 2025](https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf): annual 2026 cash-market trading holidays and weekend holidays.
- [NSE/CMTR/72260, January 12, 2026](https://nsearchives.nseindia.com/content/circulars/CMTR72260.pdf): adds the January 15 election trading holiday.
- [Current NSE holidays page](https://www.nseindia.com/resources/exchange-communication-holidays): corroborates the special Muhurat session on November 8; timings remain unannounced in the reviewed page.

Migration `006` seeds these reviewed 2026 closures and marks annual coverage. Ordinary weekdays use the configured regular session; explicit holidays close it. The November 8 special session has `review_required=true` and remains blocked until its actual official timings are verified and imported. This is an explicit unresolved schedule, not an invented closure or assumed normal session.

No 2027 schedule has been verified or seeded. Executable trading and session-based expiry calculation require reviewed year coverage; absence is exposed as `CALENDAR_REQUIRED`. Import each year's complete annual schedule, including amendments and special sessions, after reviewing authoritative NSE sources. Annual coverage is not a guarantee against later exchange amendments: review and import any newly announced closures/session changes.

`nse-2026.json` mirrors the seed and can be used with the reviewed annual calendar importer. Preserve `reviewRequired:true` on unresolved special dates. When verified Muhurat timings become available, set that date to `isOpen:true`, provide the actual `openTime`/`closeTime`, clear `reviewRequired`, and record the new source before importing the complete annual file.
