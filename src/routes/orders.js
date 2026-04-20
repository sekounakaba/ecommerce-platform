const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const database = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// Stripe Initialization
// ============================================================
let stripe;

function getStripe() {
  if (!stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is not configured');
    }
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-06-20',
      typescript: true,
    });
  }
  return stripe;
}

// ============================================================
// Validation Schemas
// ============================================================

const createOrderSchema = Joi.object({
  items: Joi.array().items(
    Joi.object({
      productId: Joi.string().uuid().required(),
      quantity: Joi.number().integer().min(1).max(100).required(),
    })
  ).min(1).max(50).required().messages({
    'array.min': 'La commande doit contenir au moins un article.',
    'array.max': 'La commande ne peut pas contenir plus de 50 articles.',
    'any.required': 'Les articles de la commande sont requis.',
  }),
  shippingAddress: Joi.object({
    firstName: Joi.string().min(2).max(100).required(),
    lastName: Joi.string().min(2).max(100).required(),
    address1: Joi.string().min(5).max(255).required(),
    address2: Joi.string().max(255).allow('').optional(),
    city: Joi.string().min(2).max(100).required(),
    state: Joi.string().max(100).allow('').optional(),
    postalCode: Joi.string().min(3).max(20).required(),
    country: Joi.string().length(2).default('FR'),
    phone: Joi.string().max(20).allow('').optional(),
  }).required(),
  billingAddress: Joi.object({
    firstName: Joi.string().min(2).max(100).required(),
    lastName: Joi.string().min(2).max(100).required(),
    address1: Joi.string().min(5).max(255).required(),
    address2: Joi.string().max(255).allow('').optional(),
    city: Joi.string().min(2).max(100).required(),
    state: Joi.string().max(100).allow('').optional(),
    postalCode: Joi.string().min(3).max(20).required(),
    country: Joi.string().length(2).default('FR'),
  }).optional(),
  notes: Joi.string().max(1000).allow('').optional(),
  couponCode: Joi.string().max(20).allow('').optional(),
  currency: Joi.string().length(3).default('EUR'),
});

const updateOrderStatusSchema = Joi.object({
  status: Joi.string().valid(
    'pending', 'confirmed', 'processing', 'shipped',
    'delivered', 'cancelled', 'refunded', 'failed'
  ).required(),
  trackingNumber: Joi.string().max(100).allow('').optional(),
  notes: Joi.string().max(1000).allow('').optional(),
  notifyCustomer: Joi.boolean().default(true),
});

// ============================================================
// Helper: Generate unique order number
// ============================================================
async function generateOrderNumber() {
  const prefix = 'ECO';
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  const orderNumber = `${prefix}-${timestamp}-${random}`;

  // Verify uniqueness
  const existing = await database.query(
    'SELECT id FROM orders WHERE order_number = $1',
    [orderNumber]
  );

  if (existing.rows.length > 0) {
    return generateOrderNumber(); // Retry with new number
  }

  return orderNumber;
}

// ============================================================
// Helper: Calculate order totals
// ============================================================
function calculateTotals(items, taxRate = 0.20) {
  const subtotal = items.reduce((sum, item) => {
    return sum + (parseFloat(item.unit_price) * parseInt(item.quantity));
  }, 0);

  const taxAmount = parseFloat((subtotal * taxRate).toFixed(2));
  const total = parseFloat((subtotal + taxAmount).toFixed(2));

  return { subtotal, taxAmount, total };
}

// ============================================================
// Helper: Format order response
// ============================================================
function formatOrder(order, items = []) {
  if (!order) return null;

  return {
    id: order.id,
    orderNumber: order.order_number,
    userId: order.user_id,
    status: order.status,
    items: items.map(item => ({
      id: item.id,
      productId: item.product_id,
      productName: item.product_name,
      productSku: item.product_sku,
      productImage: item.product_image,
      quantity: parseInt(item.quantity),
      unitPrice: parseFloat(item.unit_price),
      totalPrice: parseFloat(item.total_price),
    })),
    subtotal: parseFloat(order.subtotal),
    taxAmount: parseFloat(order.tax_amount),
    shippingAmount: parseFloat(order.shipping_amount),
    discountAmount: parseFloat(order.discount_amount),
    total: parseFloat(order.total),
    currency: order.currency,
    shippingAddress: order.shipping_address,
    billingAddress: order.billing_address,
    paymentIntentId: order.stripe_payment_intent_id,
    paidAt: order.paid_at,
    shippedAt: order.shipped_at,
    deliveredAt: order.delivered_at,
    cancelledAt: order.cancelled_at,
    notes: order.notes,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  };
}

// ============================================================
// Helper: Get shipping cost based on subtotal
// ============================================================
function calculateShipping(subtotal, country = 'FR') {
  const shippingRules = {
    FR: { freeThreshold: 50, standard: 5.90, express: 9.90 },
    EU: { freeThreshold: 100, standard: 9.90, express: 14.90 },
    WORLD: { freeThreshold: 200, standard: 19.90, express: 29.90 },
  };

  const rule = shippingRules[country] || shippingRules.WORLD;
  return subtotal >= rule.freeThreshold ? 0 : rule.standard;
}

// ============================================================
// POST /api/orders - Create a new order
// ============================================================
router.post('/', authenticate, async (req, res) => {
  try {
    const { error, value } = createOrderSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Données de commande invalides.',
          details: error.details.map(d => ({ field: d.path.join('.'), message: d.message })),
        },
        requestId: req.requestId,
      });
    }

    // Start a transaction for atomic order creation
    const orderResult = await database.transaction(async (client) => {
      // 1. Validate all products and get prices
      const productIds = value.items.map(item => item.productId);
      const placeholders = value.items.map((_, i) => `$${i + 1}`).join(', ');

      const productResult = await client.query(
        `SELECT id, name, sku, price, stock_quantity, images, is_active
         FROM products WHERE id IN (${placeholders}) FOR UPDATE`,
        productIds
      );

      if (productResult.rows.length !== value.items.length) {
        const foundIds = productResult.rows.map(p => p.id);
        const missingIds = value.items
          .filter(item => !foundIds.includes(item.productId))
          .map(item => item.productId);
        const err = new Error(`Produits non trouvés: ${missingIds.join(', ')}`);
        err.code = 'PRODUCTS_NOT_FOUND';
        err.statusCode = 400;
        throw err;
      }

      // Check for inactive products
      const inactiveProducts = productResult.rows.filter(p => !p.is_active);
      if (inactiveProducts.length > 0) {
        const err = new Error(`Produits indisponibles: ${inactiveProducts.map(p => p.name).join(', ')}`);
        err.code = 'PRODUCTS_UNAVAILABLE';
        err.statusCode = 400;
        throw err;
      }

      // Create product map for quick lookup
      const productMap = {};
      productResult.rows.forEach(p => { productMap[p.id] = p; });

      // 2. Check stock availability
      const insufficientStock = [];
      value.items.forEach(item => {
        const product = productMap[item.productId];
        if (product.stock_quantity < item.quantity) {
          insufficientStock.push({
            product: product.name,
            requested: item.quantity,
            available: product.stock_quantity,
          });
        }
      });

      if (insufficientStock.length > 0) {
        const err = new Error('Stock insuffisant pour certains produits.');
        err.code = 'INSUFFICIENT_STOCK';
        err.statusCode = 400;
        err.details = insufficientStock;
        throw err;
      }

      // 3. Calculate totals
      const orderItems = value.items.map(item => {
        const product = productMap[item.productId];
        return {
          product_id: product.id,
          product_name: product.name,
          product_sku: product.sku,
          product_image: Array.isArray(product.images) && product.images.length > 0 ? product.images[0] : null,
          quantity: item.quantity,
          unit_price: product.price,
          total_price: (parseFloat(product.price) * item.quantity).toFixed(2),
        };
      });

      const { subtotal, taxAmount, total } = calculateTotals(orderItems);
      const shippingAmount = calculateShipping(subtotal, value.shippingAddress.country);
      const grandTotal = parseFloat((total + shippingAmount).toFixed(2));

      // 4. Generate order
      const orderId = uuidv4();
      const orderNumber = await generateOrderNumber();

      // Use billing address or default to shipping address
      const billingAddress = value.billingAddress || value.shippingAddress;

      const orderInsert = await client.query(`
        INSERT INTO orders (
          id, order_number, user_id, status,
          subtotal, tax_amount, shipping_amount, discount_amount, total, currency,
          shipping_address, billing_address, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
      `, [
        orderId, orderNumber, req.user.id, 'pending',
        subtotal, taxAmount, shippingAmount, 0, grandTotal, value.currency,
        JSON.stringify(value.shippingAddress),
        JSON.stringify(billingAddress),
        value.notes,
      ]);

      // 5. Insert order items
      const itemInsertPromises = orderItems.map(item => {
        return client.query(`
          INSERT INTO order_items (
            id, order_id, product_id, product_name, product_sku,
            product_image, quantity, unit_price, total_price
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING *
        `, [
          uuidv4(), orderId, item.product_id, item.product_name, item.product_sku,
          item.product_image, item.quantity, item.unit_price, item.total_price,
        ]);
      });

      const itemResults = await Promise.all(itemInsertPromises);

      // 6. Decrease stock quantities
      const stockUpdatePromises = value.items.map(item => {
        return client.query(`
          UPDATE products SET stock_quantity = stock_quantity - $1 WHERE id = $2
        `, [item.quantity, item.productId]);
      });

      await Promise.all(stockUpdatePromises);

      // 7. Log stock movements
      const stockLogPromises = value.items.map(item => {
        const product = productMap[item.productId];
        const newStock = product.stock_quantity - item.quantity;
        return client.query(`
          INSERT INTO stock_movements (product_id, quantity_change, previous_quantity, new_quantity, reason, reference_id, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          item.productId, -item.quantity, product.stock_quantity, newStock,
          'sale', orderId, req.user.id,
        ]);
      });

      await Promise.all(stockLogPromises);

      return {
        order: orderInsert.rows[0],
        items: itemResults.map(r => r.rows[0]),
      };
    });

    const order = formatOrder(orderResult.order, orderResult.items);

    // Create Stripe Payment Intent
    try {
      const stripeInstance = getStripe();

      // Create or retrieve Stripe customer
      let customerId;
      const userResult = await database.query(
        'SELECT stripe_customer_id FROM users WHERE id = $1',
        [req.user.id]
      );

      if (userResult.rows[0]?.stripe_customer_id) {
        customerId = userResult.rows[0].stripe_customer_id;
      } else {
        const customer = await stripeInstance.customers.create({
          email: req.user.email,
          name: `${req.user.firstName} ${req.user.lastName}`,
          metadata: { userId: req.user.id },
        });
        customerId = customer.id;
        await database.query(
          'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
          [customerId, req.user.id]
        );
      }

      // Create Payment Intent
      const paymentIntent = await stripeInstance.paymentIntents.create({
        amount: Math.round(order.total * 100), // Convert to cents
        currency: order.currency.toLowerCase(),
        customer: customerId,
        metadata: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          userId: req.user.id,
        },
        description: `Commande ${order.orderNumber}`,
        shipping: {
          name: `${value.shippingAddress.firstName} ${value.shippingAddress.lastName}`,
          address: {
            line1: value.shippingAddress.address1,
            line2: value.shippingAddress.address2 || undefined,
            city: value.shippingAddress.city,
            state: value.shippingAddress.state || undefined,
            postal_code: value.shippingAddress.postalCode,
            country: value.shippingAddress.country,
          },
          phone: value.shippingAddress.phone || undefined,
        },
        receipt_email: req.user.email,
      });

      // Save Payment Intent ID
      await database.query(
        'UPDATE orders SET stripe_payment_intent_id = $1 WHERE id = $2',
        [paymentIntent.id, order.id]
      );

      order.clientSecret = paymentIntent.client_secret;
    } catch (stripeError) {
      console.error(`[Orders] Stripe Payment Intent error: ${stripeError.message}`);

      // Don't fail the order creation, just return without payment info
      order.stripeError = 'Payment initialization failed. Contact support.';
    }

    res.status(201).json({
      success: true,
      message: 'Commande créée avec succès.',
      data: order,
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Orders] Create error: ${error.message}`);

    if (error.statusCode) {
      const response = {
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
        requestId: req.requestId,
      };
      if (error.details) {
        response.error.details = error.details;
      }
      return res.status(error.statusCode).json(response);
    }

    res.status(500).json({
      success: false,
      error: {
        code: 'ORDER_CREATE_ERROR',
        message: 'Erreur lors de la création de la commande.',
      },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// GET /api/orders - List user's orders
// ============================================================
router.get('/', authenticate, async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const offset = (page - 1) * limit;

    let query = `
      SELECT * FROM orders
      WHERE user_id = $1
    `;
    const params = [req.user.id];
    let paramIndex = 2;

    if (status) {
      query += ` AND status = $${paramIndex++}`;
      params.push(status);
    }

    // Get total count
    const countQuery = query.replace('SELECT *', 'SELECT COUNT(*)');
    const countResult = await database.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count);

    query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await database.query(query, params);

    // Get items for each order
    const orders = await Promise.all(result.rows.map(async (order) => {
      const itemsResult = await database.query(
        'SELECT * FROM order_items WHERE order_id = $1',
        [order.id]
      );
      return formatOrder(order, itemsResult.rows);
    }));

    res.json({
      success: true,
      data: {
        orders,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Orders] List error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: { code: 'ORDERS_LIST_ERROR', message: 'Erreur lors de la récupération des commandes.' },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// GET /api/orders/:id - Get order details
// ============================================================
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await database.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'ORDER_NOT_FOUND', message: 'Commande non trouvée.' },
        requestId: req.requestId,
      });
    }

    const itemsResult = await database.query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [id]
    );

    const order = formatOrder(result.rows[0], itemsResult.rows);

    res.json({
      success: true,
      data: order,
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Orders] Get error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: { code: 'ORDER_GET_ERROR', message: 'Erreur lors de la récupération de la commande.' },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// POST /api/orders/:id/pay - Confirm payment for an order
// ============================================================
router.post('/:id/pay', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { paymentMethodId } = req.body;

    if (!paymentMethodId) {
      return res.status(400).json({
        success: false,
        error: { code: 'PAYMENT_METHOD_REQUIRED', message: 'Méthode de paiement requise.' },
        requestId: req.requestId,
      });
    }

    // Get order
    const orderResult = await database.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'ORDER_NOT_FOUND', message: 'Commande non trouvée.' },
        requestId: req.requestId,
      });
    }

    const order = orderResult.rows[0];

    if (order.status === 'paid' || order.paid_at) {
      return res.status(400).json({
        success: false,
        error: { code: 'ORDER_ALREADY_PAID', message: 'Cette commande a déjà été payée.' },
        requestId: req.requestId,
      });
    }

    if (order.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        error: { code: 'ORDER_CANCELLED', message: 'Cette commande a été annulée.' },
        requestId: req.requestId,
      });
    }

    // Process payment with Stripe
    const stripeInstance = getStripe();

    let paymentIntent;

    // Use existing payment intent or create new one
    if (order.stripe_payment_intent_id) {
      try {
        paymentIntent = await stripeInstance.paymentIntents.retrieve(
          order.stripe_payment_intent_id
        );

        if (paymentIntent.status === 'succeeded') {
          // Already paid - update order
          await database.query(
            'UPDATE orders SET status = \'confirmed\', paid_at = CURRENT_TIMESTAMP, stripe_charge_id = $1 WHERE id = $2',
            [paymentIntent.latest_charge, id]
          );

          return res.json({
            success: true,
            message: 'Paiement déjà traité.',
            data: { paymentStatus: 'succeeded' },
            requestId: req.requestId,
          });
        }
      } catch (e) {
        // Create new payment intent
      }
    }

    if (!paymentIntent) {
      paymentIntent = await stripeInstance.paymentIntents.create({
        amount: Math.round(parseFloat(order.total) * 100),
        currency: order.currency.toLowerCase(),
        payment_method: paymentMethodId,
        confirm: true,
        metadata: {
          orderId: order.id,
          orderNumber: order.order_number,
        },
      });
    } else {
      paymentIntent = await stripeInstance.paymentIntents.confirm(
        order.stripe_payment_intent_id,
        { payment_method: paymentMethodId }
      );
    }

    if (paymentIntent.status === 'succeeded') {
      // Update order status
      await database.query(`
        UPDATE orders SET
          status = 'confirmed',
          stripe_payment_intent_id = $1,
          stripe_charge_id = $2,
          paid_at = CURRENT_TIMESTAMP
        WHERE id = $3
      `, [paymentIntent.id, paymentIntent.latest_charge, id]);

      const itemsResult = await database.query(
        'SELECT * FROM order_items WHERE order_id = $1',
        [id]
      );

      const updatedOrder = await database.query(
        'SELECT * FROM orders WHERE id = $1',
        [id]
      );

      return res.json({
        success: true,
        message: 'Paiement réussi ! Votre commande a été confirmée.',
        data: formatOrder(updatedOrder.rows[0], itemsResult.rows),
        requestId: req.requestId,
      });
    } else if (paymentIntent.status === 'requires_payment_method') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'PAYMENT_FAILED',
          message: 'Le paiement a échoué. Veuillez vérifier vos informations de paiement.',
          paymentStatus: paymentIntent.status,
        },
        requestId: req.requestId,
      });
    } else {
      return res.status(200).json({
        success: true,
        message: 'Paiement en cours de traitement.',
        data: { paymentStatus: paymentIntent.status, clientSecret: paymentIntent.client_secret },
        requestId: req.requestId,
      });
    }
  } catch (error) {
    console.error(`[Orders] Payment error: ${error.message}`);

    if (error.type === 'StripeCardError') {
      return res.status(400).json({
        success: false,
        error: {
          code: 'CARD_ERROR',
          message: error.message,
          declineCode: error.decline_code,
          chargeId: error.charge,
        },
        requestId: req.requestId,
      });
    }

    res.status(500).json({
      success: false,
      error: { code: 'PAYMENT_PROCESSING_ERROR', message: 'Erreur lors du traitement du paiement.' },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// POST /api/orders/:id/cancel - Cancel an order
// ============================================================
router.post('/:id/cancel', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason = '' } = req.body;

    const orderResult = await database.transaction(async (client) => {
      // Get order with lock
      const order = await client.query(
        'SELECT * FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [id, req.user.id]
      );

      if (order.rows.length === 0) {
        const err = new Error('Commande non trouvée.');
        err.statusCode = 404;
        throw err;
      }

      const currentOrder = order.rows[0];

      // Check if order can be cancelled
      if (!['pending', 'confirmed'].includes(currentOrder.status)) {
        const err = new Error(`Impossible d'annuler une commande avec le statut: ${currentOrder.status}`);
        err.statusCode = 400;
        err.code = 'ORDER_CANNOT_BE_CANCELLED';
        throw err;
      }

      // Update order status
      const update = await client.query(`
        UPDATE orders SET
          status = 'cancelled',
          cancelled_at = CURRENT_TIMESTAMP,
          notes = CASE WHEN notes IS NULL THEN $1 ELSE notes || E'\n---\nAnnulation: ' || $1 END
        WHERE id = $2
        RETURNING *
      `, [reason, id]);

      // Restore stock quantities
      const items = await client.query(
        'SELECT product_id, quantity FROM order_items WHERE order_id = $1',
        [id]
      );

      for (const item of items.rows) {
        await client.query(
          'UPDATE products SET stock_quantity = stock_quantity + $1 WHERE id = $2',
          [item.quantity, item.product_id]
        );

        await client.query(`
          INSERT INTO stock_movements (product_id, quantity_change, previous_quantity, new_quantity, reason, reference_id, created_by)
          SELECT product_id, $2, stock_quantity - $2, stock_quantity, 'return', $3, $4
          FROM products WHERE id = $1
        `, [item.product_id, item.quantity, id, req.user.id]);
      }

      // Process refund if paid
      if (currentOrder.paid_at && currentOrder.stripe_payment_intent_id) {
        try {
          const stripeInstance = getStripe();
          const refund = await stripeInstance.refunds.create({
            payment_intent: currentOrder.stripe_payment_intent_id,
            reason: 'requested_by_customer',
            metadata: {
              orderId: id,
              orderNumber: currentOrder.order_number,
              cancelledBy: req.user.id,
              reason,
            },
          });

          await client.query(`
            UPDATE orders SET status = 'refunded' WHERE id = $1
          `, [id]);

          return { order: update.rows[0], refund };
        } catch (refundError) {
          console.error(`[Orders] Refund error: ${refundError.message}`);
          // Order is still cancelled, but refund failed
          return { order: update.rows[0], refundError: refundError.message };
        }
      }

      return { order: update.rows[0] };
    });

    const itemsResult = await database.query(
      'SELECT * FROM order_items WHERE order_id = $1',
      [id]
    );

    res.json({
      success: true,
      message: 'Commande annulée avec succès.',
      data: formatOrder(orderResult.order, itemsResult.rows),
      refund: orderResult.refund ? {
        id: orderResult.refund.id,
        amount: orderResult.refund.amount / 100,
        status: orderResult.refund.status,
      } : null,
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Orders] Cancel error: ${error.message}`);

    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        error: { code: error.code || 'CANCEL_ERROR', message: error.message },
        requestId: req.requestId,
      });
    }

    res.status(500).json({
      success: false,
      error: { code: 'ORDER_CANCEL_ERROR', message: 'Erreur lors de l\'annulation de la commande.' },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// GET /api/orders/:id/status - Get order status with tracking
// ============================================================
router.get('/:id/status', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await database.query(
      `SELECT order_number, status, paid_at, shipped_at, delivered_at, cancelled_at
       FROM orders WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'ORDER_NOT_FOUND', message: 'Commande non trouvée.' },
        requestId: req.requestId,
      });
    }

    const order = result.rows[0];

    // Build status timeline
    const timeline = [
      {
        status: 'pending',
        label: 'Commande créée',
        date: order.paid_at || null,
        completed: true,
      },
    ];

    if (order.paid_at) {
      timeline.push({
        status: 'confirmed',
        label: 'Paiement confirmé',
        date: order.paid_at,
        completed: true,
      });
    }

    if (order.shipped_at) {
      timeline.push({
        status: 'processing',
        label: 'En préparation',
        date: order.shipped_at,
        completed: true,
      });
      timeline.push({
        status: 'shipped',
        label: 'Expédié',
        date: order.shipped_at,
        completed: true,
      });
    }

    if (order.delivered_at) {
      timeline.push({
        status: 'delivered',
        label: 'Livré',
        date: order.delivered_at,
        completed: true,
      });
    }

    if (order.cancelled_at) {
      timeline.push({
        status: 'cancelled',
        label: 'Annulé',
        date: order.cancelled_at,
        completed: true,
      });
    }

    res.json({
      success: true,
      data: {
        orderNumber: order.order_number,
        currentStatus: order.status,
        timeline,
      },
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Orders] Status error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: { code: 'STATUS_ERROR', message: 'Erreur lors de la récupération du statut.' },
      requestId: req.requestId,
    });
  }
});

module.exports = router;
