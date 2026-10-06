// Drill service code: never deployed for real, but ReplayOps reads its paths and line numbers.
export interface Payout { id: string; amount: number; method: "bank" | "wallet"; bank?: { iban: string; bic?: string } }

const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;

/**
 * Rejects payouts with a malformed IBAN before they reach the bank,
 * so settlement doesn't fail a day later.
 */
export function validateIban(payout: Payout) {
  // Normalise "DE89 3704 0044 0532 0130 00" style input.
  const iban = (payout.bank as { iban: string }).iban.replace(/\s+/g, "").toUpperCase();
  if (!IBAN.test(iban)) throw new Error(`Invalid IBAN for payout ${payout.id}`);
  return iban;
}
