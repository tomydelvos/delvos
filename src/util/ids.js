'use strict';
const crypto = require('node:crypto');
const { nextSeq } = require('../db');
const { localParts } = require('./time');

const pad = (n, w) => String(n).padStart(w, '0');

/** INQ-2026-00042 — reference for an incoming email. */
function inquiryRef() {
  const { year } = localParts();
  return `INQ-${year}-${pad(nextSeq(`INQ-${year}`), 5)}`;
}

/** REG-2026-00017 — registration number given to the prospective client. */
function registrationNo() {
  const { year } = localParts();
  return `REG-${year}-${pad(nextSeq(`REG-${year}`), 5)}`;
}

const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { inquiryRef, registrationNo, token };
