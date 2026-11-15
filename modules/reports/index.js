// reports: count and total records over time, and write them out as CSV.
//
// A business asks the same few questions of its records: how many, how much, by day, week or
// month, in its own time zone. This answers those for any list of records, without knowing what
// a booking or an order is: the app says where the time and the amount are.
//
//   const days = series(orders, { at: (o) => o.paidAt, amount: (o) => o.cents, by: 'day', zone: 'America/New_York', from, to });
//   // [{ start: '2026-11-14', count: 3, amount: 12_500 }, ...]   every bucket from..to, empty ones too
//   csv(days, [{ key: 'start', label: 'Day' }, { key: 'count', label: 'Orders' }])
//
// Days, weeks (starting Monday) and months are calendar periods in `zone`, not 24-hour slices,
// so a daylight saving change doesn't move a sale to the wrong day.

const BY = new Set(['day', 'week', 'month']);

/** The calendar date of an instant in a time zone, as { y, m, d }. */
function dateIn(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

const pad = (n) => String(n).padStart(2, '0');
const iso = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
/** Whole days since 1970-01-01 for a calendar date, no time zone involved. */
const dayNumber = ({ y, m, d }) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
const fromDayNumber = (n) => {
  const date = new Date(n * 86_400_000);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
};

/** The first day of the bucket a calendar date falls in. */
function startOf(date, by) {
  if (by === 'month') return { y: date.y, m: date.m, d: 1 };
  if (by === 'week') {
    const n = dayNumber(date);
    const weekday = (new Date(n * 86_400_000).getUTCDay() + 6) % 7; // Monday is 0
    return fromDayNumber(n - weekday);
  }
  return date;
}

function next(start, by) {
  if (by === 'month') return start.m === 12 ? { y: start.y + 1, m: 1, d: 1 } : { y: start.y, m: start.m + 1, d: 1 };
  return fromDayNumber(dayNumber(start) + (by === 'week' ? 7 : 1));
}

/**
 * Records grouped into calendar buckets, oldest first. `from` and `to` are instants (ms); every
 * bucket between them is listed, empty ones with a count of 0. A record whose `at` is missing or
 * outside the range is left out. `amount` is summed as given (use whole cents).
 */
export function series(records, { at, amount = () => 0, by = 'day', zone = 'UTC', from, to } = {}) {
  if (typeof at !== 'function') throw new TypeError('series needs at(record)');
  if (!BY.has(by)) throw new TypeError("by is 'day', 'week' or 'month'");
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new TypeError('series needs from <= to, as instants in ms');
  new Intl.DateTimeFormat('en-US', { timeZone: zone }); // throws on an unknown zone

  const first = startOf(dateIn(from, zone), by);
  const last = startOf(dateIn(to, zone), by);
  const buckets = new Map();
  for (let start = first; dayNumber(start) <= dayNumber(last); start = next(start, by)) {
    buckets.set(iso(start), { start: iso(start), count: 0, amount: 0 });
    if (buckets.size > 5000) throw new RangeError('That range has more than 5000 buckets');
  }
  for (const record of records) {
    const when = at(record);
    if (!Number.isFinite(when) || when < from || when > to) continue;
    const bucket = buckets.get(iso(startOf(dateIn(when, zone), by)));
    if (!bucket) continue;
    bucket.count += 1;
    const value = Number(amount(record));
    if (Number.isFinite(value)) bucket.amount += value;
  }
  return [...buckets.values()];
}

/** Count and total of a list of records, the headline numbers above a chart. */
export function totals(records, { amount = () => 0 } = {}) {
  let count = 0;
  let sum = 0;
  for (const record of records) {
    count += 1;
    const value = Number(amount(record));
    if (Number.isFinite(value)) sum += value;
  }
  return { count, amount: sum };
}

/** Records counted by a key: `[{ key, count, amount }]`, largest count first. */
export function breakdown(records, { key, amount = () => 0 } = {}) {
  if (typeof key !== 'function') throw new TypeError('breakdown needs key(record)');
  const groups = new Map();
  for (const record of records) {
    const name = String(key(record) ?? '');
    const group = groups.get(name) ?? { key: name, count: 0, amount: 0 };
    group.count += 1;
    const value = Number(amount(record));
    if (Number.isFinite(value)) group.amount += value;
    groups.set(name, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/**
 * Rows as CSV (RFC 4180, CRLF line ends), with a header from `columns`. A cell that a spreadsheet
 * would run as a formula (starting =, +, -, @, tab or carriage return) is prefixed with ' so it
 * opens as text. Numbers are written as they are.
 */
export function csv(rows, columns) {
  if (!Array.isArray(columns) || !columns.length) throw new TypeError('csv needs columns: [{ key, label }]');
  const cell = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.map((column) => cell(column.label ?? column.key)).join(',')];
  for (const row of rows) lines.push(columns.map((column) => cell(typeof column.value === 'function' ? column.value(row) : row[column.key])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
