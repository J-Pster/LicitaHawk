import { reconcilePlanTiers } from "../src/billing/reconciliation.service";

reconcilePlanTiers()
  .then((result) => {
    console.log("resultado:", JSON.stringify(result, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error("falha", err);
    process.exit(1);
  });
