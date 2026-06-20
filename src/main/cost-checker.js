'use strict';

const { CostExplorerClient, GetCostAndUsageCommand } = require('@aws-sdk/client-cost-explorer');

/**
 * Fetches the unblended cost for the current calendar month.
 * Cost Explorer is always us-east-1 regardless of the account region.
 */
async function getCurrentMonthCost(credentials) {
  const client = new CostExplorerClient({ credentials, region: 'us-east-1' });

  const now   = new Date();
  const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  // End must be today or earlier (exclusive upper bound)
  const end   = now.toISOString().slice(0, 10);

  // If start === end (first day of month) push end forward one day
  const endDate = start === end
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString().slice(0, 10)
    : end;

  const resp = await client.send(new GetCostAndUsageCommand({
    TimePeriod:  { Start: start, End: endDate },
    Granularity: 'MONTHLY',
    Metrics:     ['UnblendedCost'],
  }));

  const row    = resp.ResultsByTime?.[0];
  const amount = parseFloat(row?.Total?.UnblendedCost?.Amount || '0');
  const unit   = row?.Total?.UnblendedCost?.Unit || 'USD';

  return { ok: true, amount, unit, start, end: endDate };
}

module.exports = { getCurrentMonthCost };
