export function money(amount: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    amount / 100,
  );
}

export function parseStake(input: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(input.trim()))
    throw new Error('Enter a positive amount with at most two decimals.');
  const [whole, fraction = ''] = input.trim().split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents < 1n || cents > 1_000_000_000n)
    throw new Error('Stake must be between $0.01 and $10,000,000.00.');
  return Number(cents);
}
