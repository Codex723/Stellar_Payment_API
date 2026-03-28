import express from "express";
import { z } from "zod";
import { supabase } from "../lib/supabase.js";
import { sendWebhook } from "../lib/webhooks.js";
import { queueBulkWebhookRetries } from "../lib/webhook-retries.js";

const router = express.Router();
const bulkRetrySchema = z.object({
  log_ids: z.array(z.string().uuid()).min(1).max(100),
});

/**
 * @swagger
 * /api/webhooks/test:
 *   post:
 *     summary: Send a test webhook to the merchant's stored webhook URL
 *     tags: [Webhooks]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Test webhook dispatched
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:
 *                   type: boolean
 *                 status:
 *                   type: integer
 *                 body:
 *                   type: string
 *                 signed:
 *                   type: boolean
 *       400:
 *         description: No webhook URL configured
 *       401:
 *         description: Missing or invalid API key
 */

router.post("/webhooks/test", async (req, res, next) => {
  try {
    // 1. Fetch the merchant's webhook_url and webhook_secret from DB
    const { data: merchant, error } = await supabase
      .from("merchants")
      .select("webhook_url, webhook_secret")
      .eq("id", req.merchant.id)
      .maybeSingle();

    if (error) {
      error.status = 500;
      throw error;
    }

    // 2. Guard: merchant must have a webhook URL saved
    if (!merchant?.webhook_url) {
      return res.status(400).json({
        error: "No webhook URL configured for this merchant.",
      });
    }

    // 3. Build a dummy payload mimicking a real payment.confirmed event
    const dummyPayload = {
      event: "payment.confirmed",
      test: true,
      payment_id: "00000000-0000-0000-0000-000000000000",
      amount: "1.00",
      asset: "XLM",
      asset_issuer: null,
      recipient: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      tx_id: "test_tx_abc123",
    };

    // 4. Send the webhook using the existing sendWebhook utility
    const result = await sendWebhook(
      merchant.webhook_url,
      dummyPayload,
      merchant.webhook_secret
    );

    // 5. Return the result
    res.json({
      ok: result.ok,
      status: result.status,
      body: result.body,
      signed: result.signed,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/webhook-logs", async (req, res, next) => {
  try {
    const { rows } = await req.app.locals.pool.query(
      `
        select
          l.id,
          l.payment_id,
          l.status_code,
          l.timestamp as created_at,
          p.webhook_url as url
        from webhook_delivery_logs l
        join payments p on p.id = l.payment_id
        where p.merchant_id = $1
        order by l.timestamp desc
      `,
      [req.merchant.id],
    );

    res.json({
      logs: rows.map((row) => ({
        ...row,
        event: "payment.confirmed",
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/webhooks/retry-bulk", async (req, res, next) => {
  try {
    const body = bulkRetrySchema.parse(req.body || {});
    const result = await queueBulkWebhookRetries({
      db: req.app.locals.pool,
      merchantId: req.merchant.id,
      logIds: body.log_ids,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
