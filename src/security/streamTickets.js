"use strict";

const crypto = require("crypto");

const STREAM_TICKET_TTL_MS = Math.max(
  30_000,
  parseInt(process.env.STREAM_TICKET_TTL_MS, 10) || 120_000
);

const tickets = new Map();

function pruneExpired() {
  const now = Date.now();
  for (const [ticket, entry] of tickets.entries()) {
    if (entry.expiresAt <= now) tickets.delete(ticket);
  }
}

function issueStreamTicket(stream) {
  if (!['logs', 'progress'].includes(stream)) {
    throw new Error("Unsupported stream ticket type.");
  }

  pruneExpired();
  const ticket = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + STREAM_TICKET_TTL_MS;
  tickets.set(ticket, { stream, expiresAt });

  return {
    ticket,
    stream,
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function validateStreamTicket(ticket, stream) {
  if (!ticket || !stream) return false;
  const entry = tickets.get(ticket);
  if (!entry || entry.expiresAt <= Date.now() || entry.stream !== stream) {
    if (entry) tickets.delete(ticket);
    return false;
  }
  return true;
}

module.exports = {
  issueStreamTicket,
  validateStreamTicket
};
