// 示例技能脚本：对账发票与付款记录，输出 paid/partial/unpaid/overpaid 状态。
// 输入优先从 stdin 读取 JSON，没有 stdin 时回退到 data/input.json。
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** 读取输入：stdin 有内容时优先使用，否则读当前目录的 data/input.json。 */
async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw.length > 0) return JSON.parse(raw);
  return JSON.parse(readFileSync(path.join(process.cwd(), 'data', 'input.json'), 'utf8'));
}

/**
 * 对账核心逻辑：
 * 1. 校验发票字段；2. 逐笔校验付款并去重累加；
 * 3. 按差额（保留两位小数）判定状态。
 */
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

  // 用 Set 检测重复付款 id，避免同一笔款被计两次。
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

  // 金额以分为单位四舍五入，容差 0.005 用于吸收浮点误差。
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

// 入口：读取输入后把结果以单行 JSON 写到 stdout，供评测器解析。
const document = await readInput();
process.stdout.write(`${JSON.stringify(reconcile(document))}\n`);
