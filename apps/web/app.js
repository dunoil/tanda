// Receipts explorer. Reads a static receipts.json export of the desk ledger
// (same shape the server ledger produces) and renders each job with its
// verification tier and Celoscan links. Until the first real job settles,
// the page shows the empty state from index.html.
async function loadReceipts() {
  try {
    const res = await fetch("receipts.json");
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.jobs) || data.jobs.length === 0) return;
    const el = document.getElementById("receipts");
    el.innerHTML = "";
    for (const job of data.jobs) {
      const div = document.createElement("div");
      div.textContent = `Job ${job.id}: ${job.service} | tier ${job.tier} | payout ${job.idrxAmount} IDRX | tx ${job.payoutTx}`;
      el.appendChild(div);
    }
    document.getElementById("count-jobs").textContent = String(data.jobs.length);
    document.getElementById("count-payouts").textContent = String(
      data.jobs.filter((j) => j.payoutTx).length,
    );
  } catch {
    // Static hosting without an export yet: keep the empty state.
  }
}
loadReceipts();
