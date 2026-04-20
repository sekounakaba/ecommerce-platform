const database = require('../config/database');

// ============================================================
// Stripe Webhook Handler
// ============================================================

async function stripeWebhook(req, res) {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).json({
      success: false,
      error: { code: 'MISSING_SIGNATURE', message: 'Stripe signature manquante.' },
    });
  }

  let event;

  try {
    const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-06-20',
    });

    event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(`[Webhook] Signature verification failed: ${err.message}`);
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_SIGNATURE', message: 'Signature webhook invalide.' },
    });
  }

  // Handle specific events
  try {
    switch (event.type) {
      case 'payment_intent.succeeded':
        await handlePaymentSuccess(event.data.object);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentFailure(event.data.object);
        break;

      case 'charge.refunded':
        await handleRefund(event.data.object);
        break;

      case 'charge.dispute.created':
        await handleDispute(event.data.object);
        break;

      case 'customer.created':
        console.log(`[Webhook] Customer created: ${event.data.object.id}`);
        break;

      case 'payment_method.attached':
        console.log(`[Webhook] Payment method attached to customer: ${event.data.object.customer}`);
        break;

      default:
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }

    // Return 200 to acknowledge receipt
    res.json({ received: true, event: event.type });
  } catch (error) {
    console.error(`[Webhook] Error processing event ${event.type}: ${error.message}`);

    // Still return 200 to prevent Stripe from retrying
    // Log the error for manual investigation
    res.status(500).json({
      success: false,
      error: { code: 'WEBHOOK_PROCESSING_ERROR', message: 'Erreur lors du traitement du webhook.' },
      event: event.type,
    });
  }
}

// ============================================================
// Event Handlers
// ============================================================

async function handlePaymentSuccess(paymentIntent) {
  const { orderId, orderNumber } = paymentIntent.metadata;

  if (!orderId) {
    console.warn('[Webhook] No orderId in payment intent metadata');
    return;
  }

  console.log(`[Webhook] Payment succeeded for order ${orderNumber} (${orderId})`);

  await database.query(`
    UPDATE orders SET
      status = 'confirmed',
      stripe_payment_intent_id = $1,
      stripe_charge_id = $2,
      paid_at = CURRENT_TIMESTAMP
    WHERE id = $3 AND status IN ('pending', 'failed')
  `, [paymentIntent.id, paymentIntent.latest_charge, orderId]);

  // TODO: Send confirmation email to customer
  // TODO: Notify admin of new order
}

async function handlePaymentFailure(paymentIntent) {
  const { orderId, orderNumber } = paymentIntent.metadata;

  if (!orderId) {
    console.warn('[Webhook] No orderId in failed payment intent metadata');
    return;
  }

  console.log(`[Webhook] Payment failed for order ${orderNumber} (${orderId})`);

  await database.query(`
    UPDATE orders SET status = 'failed' WHERE id = $1 AND status = 'pending'
  `, [orderId]);

  // Restore stock
  const items = await database.query(
    'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
    [orderId]
  );

  for (const item of items.rows) {
    await database.query(
      'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2',
      [item.quantity, item.product_id]
    );
  }

  // TODO: Send payment failure notification to customer
}

async function handleRefund(charge) {
  console.log(`[Webhook] Charge refunded: ${charge.id}`);

  const paymentIntentId = charge.payment_intent;

  const result = await database.query(
    'SELECT id, order_number FROM orders WHERE stripe_charge_id = $1',
    [charge.id]
  );

  if (result.rows.length === 0) {
    // Try by payment intent
    const result2 = await database.query(
      'SELECT id, order_number FROM orders WHERE stripe_payment_intent_id = $1',
      [paymentIntentId]
    );

    if (result2.rows.length === 0) {
      console.warn(`[Webhook] No order found for charge ${charge.id}`);
      return;
    }

    await database.query(
      'UPDATE orders SET status = \'refunded\' WHERE id = $1',
      [result2.rows[0].id]
    );

    console.log(`[Webhook] Order ${result2.rows[0].order_number} marked as refunded`);
  } else {
    await database.query(
      'UPDATE orders SET status = \'refunded\' WHERE id = $1',
      [result.rows[0].id]
    );

    console.log(`[Webhook] Order ${result.rows[0].order_number} marked as refunded`);
  }
}

async function handleDispute(dispute) {
  console.log(`[Webhook] Dispute created: ${dispute.id} for charge ${dispute.charge}`);

  const result = await database.query(
    'SELECT id, order_number FROM orders WHERE stripe_charge_id = $1',
    [dispute.charge]
  );

  if (result.rows.length > 0) {
    console.warn(`[Webhook] Dispute on order ${result.rows[0].order_number}`);
    // TODO: Notify admin of dispute
    // TODO: Update order status or add note
  }
}

module.exports = { stripeWebhook };
