'use strict';

// Mock the AWS SDK — we're only testing the date logic, not the API call
jest.mock('@aws-sdk/client-cost-explorer', () => ({
  CostExplorerClient: jest.fn().mockImplementation(() => ({
    send: jest.fn().mockResolvedValue({
      ResultsByTime: [{
        Total: { UnblendedCost: { Amount: '142.73', Unit: 'USD' } },
      }],
    }),
  })),
  GetCostAndUsageCommand: jest.fn(),
}));

const { getCurrentMonthCost } = require('../src/main/cost-checker');

describe('getCurrentMonthCost', () => {
  it('returns the amount and unit from Cost Explorer', async () => {
    const result = await getCurrentMonthCost({});
    expect(result.ok).toBe(true);
    expect(result.amount).toBe(142.73);
    expect(result.unit).toBe('USD');
  });

  it('start date is always the 1st of the current month', async () => {
    const result = await getCurrentMonthCost({});
    expect(result.start).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('end date is never before start date', async () => {
    const result = await getCurrentMonthCost({});
    expect(new Date(result.end) >= new Date(result.start)).toBe(true);
  });

  it('handles first day of month — end pushed forward one day', async () => {
    // Freeze to the 1st of a month
    const RealDate = Date;
    jest.spyOn(global, 'Date').mockImplementation((...args) => {
      if (args.length === 0) return new RealDate('2026-07-01T10:00:00Z');
      return new RealDate(...args);
    });
    Date.now = () => new RealDate('2026-07-01T10:00:00Z').getTime();

    const result = await getCurrentMonthCost({});
    expect(result.start).toBe('2026-07-01');
    expect(result.end).not.toBe('2026-07-01'); // must be pushed forward

    jest.restoreAllMocks();
  });

  it('returns amount 0 when Cost Explorer returns no data', async () => {
    const { CostExplorerClient } = require('@aws-sdk/client-cost-explorer');
    CostExplorerClient.mockImplementationOnce(() => ({
      send: jest.fn().mockResolvedValue({ ResultsByTime: [] }),
    }));
    const result = await getCurrentMonthCost({});
    expect(result.ok).toBe(true);
    expect(result.amount).toBe(0);
  });
});
