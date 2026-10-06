'use strict';
const config = require('../config');

/** SQLite datetime('now') strings are UTC "YYYY-MM-DD HH:MM:SS". */
const fromDb = (s) => (s ? new Date(`${String(s).replace(' ', 'T')}Z`) : null);
const toDb = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

function localParts(date = new Date(), tz = config.timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { dow, hour: Number(parts.hour), minute: Number(parts.minute), date: `${parts.year}-${parts.month}-${parts.day}`, year: Number(parts.year) };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return h * 60 + (m || 0);
};

function isOfficeOpen(office, date = new Date()) {
  const oh = office.officeHours || {};
  const p = localParts(date);
  const now = p.hour * 60 + p.minute;
  return (oh.days || [1, 2, 3, 4, 5]).includes(p.dow) && now >= toMinutes(oh.start) && now < toMinutes(oh.end);
}

/**
 * Response deadline: created + slaHours; if that lands outside office hours,
 * roll forward to the next opening (so promises to clients stay honest).
 */
function slaDue(office, from = new Date()) {
  let due = new Date(from.getTime() + Number(office.slaHours || 24) * 3600e3);
  for (let i = 0; i < 24 * 8 && !isOfficeOpen(office, due); i += 1) {
    due = new Date(due.getTime() + 15 * 60e3);
    // Snap to quarter hours while searching for the next opening.
    due.setUTCMinutes(Math.floor(due.getUTCMinutes() / 15) * 15, 0, 0);
  }
  return due;
}

function formatDateTime(date) {
  if (!date) return '-';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: config.timezone, day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(date);
}

const hoursBetween = (a, b = new Date()) => Math.floor((b - a) / 3600e3);

module.exports = { fromDb, toDb, localParts, isOfficeOpen, slaDue, formatDateTime, hoursBetween };
