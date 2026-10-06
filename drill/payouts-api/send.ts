// Drill service code: never deployed for real, but ReplayOps reads its paths and line numbers.
import { validateIban, type Payout } from "./iban";

export async function sendPayout(payout: Payout, bank: { transfer(iban: string, amount: number): Promise<void> }) {
  const iban = validateIban(payout);
  await bank.transfer(iban, payout.amount);
}
