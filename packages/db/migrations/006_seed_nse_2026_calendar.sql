-- Reviewed 2026-10-31 using authoritative NSE Capital Market sources:
-- Annual calendar: https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf
-- Jan 15 amendment: https://nsearchives.nseindia.com/content/circulars/CMTR72260.pdf
-- Muhurat timings are explicitly unannounced in the reviewed source, so Nov 8 is gated.
INSERT INTO market_sessions(date,is_open,description,source,review_required) VALUES
('2026-01-15',false,'Municipal Corporation Election in Maharashtra','https://nsearchives.nseindia.com/content/circulars/CMTR72260.pdf',false),
('2026-01-26',false,'Republic Day','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-02-15',false,'Mahashivratri (Sunday)','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-03-03',false,'Holi','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-03-21',false,'Id-Ul-Fitr (Saturday)','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-03-26',false,'Shri Ram Navami','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-03-31',false,'Shri Mahavir Jayanti','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-04-03',false,'Good Friday','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-04-14',false,'Dr. Baba Saheb Ambedkar Jayanti','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-05-01',false,'Maharashtra Day','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-05-28',false,'Bakri Id','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-06-26',false,'Muharram','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-08-15',false,'Independence Day (Saturday)','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-09-14',false,'Ganesh Chaturthi','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-10-02',false,'Mahatma Gandhi Jayanti','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-10-20',false,'Dussehra','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-11-08',false,'Muhurat special session: import verified official timings before trading','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',true),
('2026-11-10',false,'Diwali-Balipratipada','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-11-24',false,'Prakash Gurpurb Sri Guru Nanak Dev','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false),
('2026-12-25',false,'Christmas','https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf',false)
ON CONFLICT (date) DO NOTHING;

INSERT INTO market_calendar_years(year,source) VALUES
(2026,'https://nsearchives.nseindia.com/content/circulars/CMTR71775.pdf ; amendment https://nsearchives.nseindia.com/content/circulars/CMTR72260.pdf ; reviewed 2026-10-31; Nov 8 special session requires timing review')
ON CONFLICT (year) DO NOTHING;
