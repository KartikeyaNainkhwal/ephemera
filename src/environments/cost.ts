/**
 * Cost estimation.
 *
 * Zerops bills resources by the minute. Published rates, per 30 days:
 *
 *   shared CPU core   $0.60
 *   RAM               $0.75 per 0.25 GB   ->  $3.00 / GB
 *   disk              $0.05 per 0.5 GB    ->  $0.10 / GB
 *
 * An environment is one small application container plus one small PostgreSQL
 * container. These are the minimum allocations each is created with, so the
 * figure is a floor rather than a measured bill - it is labelled as an
 * estimate everywhere it is shown.
 */

const HOURS_PER_BILLING_PERIOD = 30 * 24;

const RATE_PER_30_DAYS = {
  cpuCore: 0.6,
  ramPerGb: 3.0,
  diskPerGb: 0.1,
} as const;

interface Allocation {
  cpuCores: number;
  ramGb: number;
  diskGb: number;
}

const APP_ALLOCATION: Allocation = { cpuCores: 1, ramGb: 0.25, diskGb: 1 };
const DB_ALLOCATION: Allocation = { cpuCores: 1, ramGb: 0.25, diskGb: 1 };

function costPerHour(allocation: Allocation): number {
  const per30Days =
    allocation.cpuCores * RATE_PER_30_DAYS.cpuCore +
    allocation.ramGb * RATE_PER_30_DAYS.ramPerGb +
    allocation.diskGb * RATE_PER_30_DAYS.diskPerGb;
  return per30Days / HOURS_PER_BILLING_PERIOD;
}

/** Hourly cost of a single environment, in US dollars. */
export function hourlyCost(withDatabase: boolean): number {
  return costPerHour(APP_ALLOCATION) + (withDatabase ? costPerHour(DB_ALLOCATION) : 0);
}

/**
 * Accrued cost for an environment between creation and teardown (or now, if
 * it is still standing).
 */
export function accruedCost(
  createdAt: Date,
  destroyedAt: Date | null,
  withDatabase: boolean,
): number {
  const end = destroyedAt ?? new Date();
  const hours = Math.max(0, end.getTime() - createdAt.getTime()) / 3_600_000;
  return hours * hourlyCost(withDatabase);
}

/**
 * Format small dollar amounts without collapsing them to "$0.00".
 * A three-minute environment genuinely costs a fraction of a cent, and
 * rounding that away would misrepresent the economics.
 */
export function formatCost(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  return `$${amount.toFixed(5)}`;
}
