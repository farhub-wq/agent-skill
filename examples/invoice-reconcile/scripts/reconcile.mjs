import { readFileSync } from 'node:fs';
import path from 'node:path';

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length > 0) return JSON.parse(raw);
  return JSON.parse(readFileSync(path.join(process.cwd(), 'data', 'input.json'), 'utf8'));
}

function reconcile(document) {
  const invoice = document?.invoice;
  const payments = document?.payments;

  if (invoice === null || typeof invoice !== 'object' || typeof invoice.id !== 'string' || invoice.id.length === 0) {
    return { error: 'invalid-invoice-id' };
  }
  if (typeof invoice.amount !== 'number' || !Number.isFinite(invoice.amount) || invoice.amount < 0) {
    return { error: 'invalid-amount' };
  }
  if (!Array.isArray(payments)) {
    return { error: 'invalid-payments' };
  }

  const seen = new Set();
  let total = 0;
  for (const payment of payments) {
    if (
      payment === null ||
      typeof payment !== 'object' ||
      typeof payment.id !== 'string' ||
      typeof payment.amount !== 'number' ||
      !Number.isFinite(payment.amount) ||
      payment.amount < 0
    ) {
      return { error: 'invalid-payment' };
    }
    if (seen.has(payment.id)) {
      return { error: 'duplicate-payment' };
    }
    seen.add(payment.id);
    total += payment.amount;
  }

  const round = (value) => Math.round(value * 100) / 100;
  const outstanding = round(invoice.amount - total);
  let status;
  if (Math.abs(outstanding) <= 0.005) {
    status = 'paid';
  } else if (outstanding > 0) {
    status = total === 0 ? 'unpaid' : 'partial';
  } else {
    status = 'overpaid';
  }

  return { invoiceId: invoice.id, status, outstanding };
}

const document = await readInput();
process.stdout.write(`${JSON.stringify(reconcile(document))}\n`);
