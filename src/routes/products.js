const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const slugify = require('slugify');
const database = require('../config/database');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ============================================================
// Validation Schemas
// ============================================================

const createProductSchema = Joi.object({
  name: Joi.string().min(3).max(255).required().messages({
    'string.min': 'Le nom du produit doit contenir au moins 3 caractères.',
    'string.max': 'Le nom du produit ne peut pas dépasser 255 caractères.',
    'any.required': 'Le nom du produit est requis.',
  }),
  description: Joi.string().max(5000).allow('').optional(),
  shortDescription: Joi.string().max(500).allow('').optional(),
  sku: Joi.string().max(50).optional(),
  price: Joi.number().positive().precision(2).required().messages({
    'number.positive': 'Le prix doit être un nombre positif.',
    'any.required': 'Le prix est requis.',
  }),
  compareAtPrice: Joi.number().positive().precision(2).allow(null).optional(),
  costPrice: Joi.number().positive().precision(2).allow(null).optional(),
  categoryId: Joi.number().integer().positive().optional(),
  images: Joi.array().items(Joi.string().uri()).max(10).default([]),
  stockQuantity: Joi.number().integer().min(0).default(0),
  lowStockThreshold: Joi.number().integer().min(0).default(10),
  isActive: Joi.boolean().default(true),
  isFeatured: Joi.boolean().default(false),
  weight: Joi.number().positive().precision(2).allow(null).optional(),
  tags: Joi.array().items(Joi.string().max(50)).max(20).default([]),
  metadata: Joi.object().default({}),
});

const updateProductSchema = Joi.object({
  name: Joi.string().min(3).max(255).optional(),
  description: Joi.string().max(5000).allow('').optional(),
  shortDescription: Joi.string().max(500).allow('').optional(),
  sku: Joi.string().max(50).optional(),
  price: Joi.number().positive().precision(2).optional(),
  compareAtPrice: Joi.number().positive().precision(2).allow(null).optional(),
  costPrice: Joi.number().positive().precision(2).allow(null).optional(),
  categoryId: Joi.number().integer().positive().allow(null).optional(),
  images: Joi.array().items(Joi.string().uri()).max(10).optional(),
  stockQuantity: Joi.number().integer().min(0).optional(),
  lowStockThreshold: Joi.number().integer().min(0).optional(),
  isActive: Joi.boolean().optional(),
  isFeatured: Joi.boolean().optional(),
  weight: Joi.number().positive().precision(2).allow(null).optional(),
  tags: Joi.array().items(Joi.string().max(50)).max(20).optional(),
  metadata: Joi.object().optional(),
});

const querySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().max(255).optional(),
  category: Joi.string().max(100).optional(),
  minPrice: Joi.number().positive().precision(2).optional(),
  maxPrice: Joi.number().positive().precision(2).optional(),
  sortBy: Joi.string().valid('name', 'price', 'created_at', 'updated_at', 'stock_quantity').default('created_at'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
  active: Joi.boolean().default(true),
  featured: Joi.boolean().optional(),
  tags: Joi.string().optional(),
});

// ============================================================
// Helper: Generate unique slug
// ============================================================
async function generateUniqueSlug(name, existingId = null) {
  let baseSlug = slugify(name, {
    lower: true,
    strict: true,
    locale: 'fr',
  });

  let slug = baseSlug;
  let counter = 1;

  while (true) {
    const result = await database.query(
      'SELECT id FROM products WHERE slug = $1 AND ($2 IS NULL OR id != $2)',
      [slug, existingId]
    );

    if (result.rows.length === 0) break;

    slug = `${baseSlug}-${counter}`;
    counter++;
  }

  return slug;
}

// ============================================================
// Helper: Format product response
// ============================================================
function formatProduct(product) {
  if (!product) return null;

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    shortDescription: product.short_description,
    sku: product.sku,
    price: parseFloat(product.price),
    compareAtPrice: product.compare_at_price ? parseFloat(product.compare_at_price) : null,
    costPrice: product.cost_price ? parseFloat(product.cost_price) : null,
    categoryId: product.category_id,
    images: product.images || [],
    stockQuantity: parseInt(product.stock_quantity),
    lowStockThreshold: parseInt(product.low_stock_threshold),
    isActive: product.is_active,
    isFeatured: product.is_featured,
    weight: product.weight ? parseFloat(product.weight) : null,
    tags: product.tags || [],
    metadata: product.metadata || {},
    isLowStock: product.stock_quantity <= product.low_stock_threshold,
    discountPercentage: product.compare_at_price
      ? Math.round(((parseFloat(product.compare_at_price) - parseFloat(product.price)) / parseFloat(product.compare_at_price)) * 100)
      : 0,
    createdAt: product.created_at,
    updatedAt: product.updated_at,
  };
}

// ============================================================
// GET /api/products - List products with pagination, filters, search
// ============================================================
router.get('/', async (req, res) => {
  try {
    const { error, value: query } = querySchema.validate(req.query);
    if (error) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Paramètres de requête invalides.',
          details: error.details.map(d => ({ field: d.path.join('.'), message: d.message })),
        },
        requestId: req.requestId,
      });
    }

    const { page, limit, search, category, minPrice, maxPrice, sortBy, sortOrder, active, featured, tags } = query;
    const offset = (page - 1) * limit;

    // Build WHERE clauses
    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (active !== undefined) {
      conditions.push(`p.is_active = $${paramIndex++}`);
      params.push(active);
    }

    if (featured !== undefined) {
      conditions.push(`p.is_featured = $${paramIndex++}`);
      params.push(featured);
    }

    if (search) {
      conditions.push(`(to_tsvector('french', p.name) || to_tsvector('french', p.description) || to_tsvector('french', COALESCE(p.short_description, ''))) @@ plainto_tsquery('french', $${paramIndex++})`);
      params.push(search);
    }

    if (category) {
      conditions.push(`EXISTS (SELECT 1 FROM categories c WHERE c.id = p.category_id AND c.slug = $${paramIndex++})`);
      params.push(category);
    }

    if (minPrice !== undefined) {
      conditions.push(`p.price >= $${paramIndex++}`);
      params.push(minPrice);
    }

    if (maxPrice !== undefined) {
      conditions.push(`p.price <= $${paramIndex++}`);
      params.push(maxPrice);
    }

    if (tags) {
      const tagArray = tags.split(',').map(t => t.trim());
      conditions.push(`p.tags && $${paramIndex++}`);
      params.push(tagArray);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderDirection = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
    const orderBy = `ORDER BY p.${sortBy} ${orderDirection}`;

    // Check cache first
    const cacheKey = `products:list:${JSON.stringify(query)}`;
    const cached = await database.cacheGet(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        meta: { cached: true },
        requestId: req.requestId,
      });
    }

    // Get total count
    const countQuery = `SELECT COUNT(*) FROM products p ${whereClause}`;
    const countResult = await database.query(countQuery, params);
    const total = parseInt(countResult.rows[0].count);

    // Get products
    const productQuery = `
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      ${whereClause}
      ${orderBy}
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `;
    params.push(limit, offset);

    const result = await database.query(productQuery, params);
    const products = result.rows.map(formatProduct);

    // Get category counts for facets
    const facetQuery = `
      SELECT c.id, c.name, c.slug, COUNT(p.id) as product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.is_active = true
      GROUP BY c.id, c.name, c.slug
      HAVING COUNT(p.id) > 0
      ORDER BY c.name
    `;
    const facetResult = await database.query(facetQuery);

    const response = {
      products,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      },
      facets: {
        categories: facetResult.rows,
      },
    };

    // Cache for 5 minutes
    await database.cacheSet(cacheKey, response, 300);

    res.json({
      success: true,
      data: response,
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Products] List error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: {
        code: 'PRODUCTS_LIST_ERROR',
        message: 'Erreur lors de la récupération des produits.',
      },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// GET /api/products/categories - List all categories
// ============================================================
router.get('/categories', async (req, res) => {
  try {
    const cacheKey = 'products:categories';
    const cached = await database.cacheGet(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        meta: { cached: true },
        requestId: req.requestId,
      });
    }

    const result = await database.query(`
      SELECT c.*, 
        COUNT(p.id) as product_count,
        (SELECT COUNT(*) FROM products p2 WHERE p2.category_id IN (
          SELECT id FROM categories WHERE parent_id = c.id OR id = c.id
        ) AND p2.is_active = true) as total_product_count
      FROM categories c
      LEFT JOIN products p ON p.category_id = c.id AND p.is_active = true
      WHERE c.is_active = true
      GROUP BY c.id
      ORDER BY c.sort_order ASC, c.name ASC
    `);

    await database.cacheSet(cacheKey, result.rows, 600);

    res.json({
      success: true,
      data: result.rows,
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Products] Categories error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: {
        code: 'CATEGORIES_ERROR',
        message: 'Erreur lors de la récupération des catégories.',
      },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// GET /api/products/featured - Get featured products
// ============================================================
router.get('/featured', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 8;

    const result = await database.query(`
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = true AND p.is_featured = true
      ORDER BY RANDOM()
      LIMIT $1
    `, [limit]);

    const products = result.rows.map(formatProduct);

    res.json({
      success: true,
      data: products,
      count: products.length,
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Products] Featured error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: {
        code: 'FEATURED_PRODUCTS_ERROR',
        message: 'Erreur lors de la récupération des produits vedettes.',
      },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// GET /api/products/search - Full-text search
// ============================================================
router.get('/search', async (req, res) => {
  try {
    const { q, page = 1, limit = 20 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'SEARCH_QUERY_REQUIRED',
          message: 'Un terme de recherche d\'au moins 2 caractères est requis.',
        },
        requestId: req.requestId,
      });
    }

    const offset = (page - 1) * limit;

    const searchQuery = `
      SELECT p.*, c.name as category_name, c.slug as category_slug,
        ts_rank(
          to_tsvector('french', p.name) || to_tsvector('french', p.description),
          plainto_tsquery('french', $1)
        ) as rank
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = true
        AND (
          to_tsvector('french', p.name) || to_tsvector('french', p.description)
          @@ plainto_tsquery('french', $1)
          OR p.name ILIKE $2
          OR p.sku ILIKE $3
        )
      ORDER BY rank DESC, p.created_at DESC
      LIMIT $4 OFFSET $5
    `;

    const searchTerm = q.trim();
    const result = await database.query(searchQuery, [
      searchTerm,
      `%${searchTerm}%`,
      `${searchTerm}%`,
      limit,
      offset,
    ]);

    const countQuery = `
      SELECT COUNT(*) FROM products p
      WHERE p.is_active = true
        AND (
          to_tsvector('french', p.name) || to_tsvector('french', p.description)
          @@ plainto_tsquery('french', $1)
          OR p.name ILIKE $2
          OR p.sku ILIKE $3
        )
    `;
    const countResult = await database.query(countQuery, [searchTerm, `%${searchTerm}%`, `${searchTerm}%`]);
    const total = parseInt(countResult.rows[0].count);

    const products = result.rows.map(formatProduct);

    res.json({
      success: true,
      data: {
        products,
        search: searchTerm,
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
    console.error(`[Products] Search error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: {
        code: 'SEARCH_ERROR',
        message: 'Erreur lors de la recherche de produits.',
      },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// GET /api/products/:id - Get product by ID
// ============================================================
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check cache
    const cacheKey = `product:detail:${id}`;
    const cached = await database.cacheGet(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: cached,
        meta: { cached: true },
        requestId: req.requestId,
      });
    }

    const result = await database.query(`
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: `Aucun produit trouvé avec l'identifiant: ${id}`,
        },
        requestId: req.requestId,
      });
    }

    const product = formatProduct(result.rows[0]);

    // Get related products (same category)
    const relatedResult = await database.query(`
      SELECT p.*, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.is_active = true AND p.id != $1 AND p.category_id = $2
      ORDER BY RANDOM()
      LIMIT 4
    `, [id, product.categoryId]);

    const response = {
      product,
      relatedProducts: relatedResult.rows.map(formatProduct),
    };

    // Cache for 10 minutes
    await database.cacheSet(cacheKey, response, 600);

    res.json({
      success: true,
      data: response,
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Products] Get error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: {
        code: 'PRODUCT_GET_ERROR',
        message: 'Erreur lors de la récupération du produit.',
      },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// POST /api/products - Create a new product (Admin only)
// ============================================================
router.post('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { error, value } = createProductSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Données du produit invalides.',
          details: error.details.map(d => ({ field: d.path.join('.'), message: d.message })),
        },
        requestId: req.requestId,
      });
    }

    const id = uuidv4();
    const slug = await generateUniqueSlug(value.name);

    const result = await database.query(`
      INSERT INTO products (
        id, name, slug, description, short_description, sku,
        price, compare_at_price, cost_price, category_id,
        images, stock_quantity, low_stock_threshold,
        is_active, is_featured, weight, tags, metadata
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13,
        $14, $15, $16, $17, $18
      ) RETURNING *
    `, [
      id, value.name, slug, value.description, value.shortDescription, value.sku,
      value.price, value.compareAtPrice, value.costPrice, value.categoryId,
      value.images, value.stockQuantity, value.lowStockThreshold,
      value.isActive, value.isFeatured, value.weight, value.tags, value.metadata,
    ]);

    const product = formatProduct(result.rows[0]);

    // Clear product list cache
    await database.cacheDelete('products:list:*');
    await database.cacheDelete('products:categories');

    // Log stock movement
    if (value.stockQuantity > 0) {
      await database.query(`
        INSERT INTO stock_movements (product_id, quantity_change, previous_quantity, new_quantity, reason, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [id, value.stockQuantity, 0, value.stockQuantity, 'purchase', req.user.id]);
    }

    res.status(201).json({
      success: true,
      message: 'Produit créé avec succès.',
      data: product,
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Products] Create error: ${error.message}`);

    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_ENTRY',
          message: 'Un produit avec ce nom ou SKU existe déjà.',
          field: error.constraint === 'products_sku_key' ? 'sku' : 'name',
        },
        requestId: req.requestId,
      });
    }

    res.status(500).json({
      success: false,
      error: {
        code: 'PRODUCT_CREATE_ERROR',
        message: 'Erreur lors de la création du produit.',
      },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// PUT /api/products/:id - Update a product (Admin only)
// ============================================================
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const { error, value } = updateProductSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Données de mise à jour invalides.',
          details: error.details.map(d => ({ field: d.path.join('.'), message: d.message })),
        },
        requestId: req.requestId,
      });
    }

    // Check product exists
    const existing = await database.query('SELECT * FROM products WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: 'Produit non trouvé.',
        },
        requestId: req.requestId,
      });
    }

    // Generate new slug if name changed
    if (value.name && value.name !== existing.rows[0].name) {
      value.slug = await generateUniqueSlug(value.name, id);
    }

    // Build dynamic update query
    const fields = [];
    const params = [];
    let paramIndex = 1;

    const fieldMap = {
      name: 'name',
      description: 'description',
      shortDescription: 'short_description',
      sku: 'sku',
      price: 'price',
      compareAtPrice: 'compare_at_price',
      costPrice: 'cost_price',
      categoryId: 'category_id',
      images: 'images',
      stockQuantity: 'stock_quantity',
      lowStockThreshold: 'low_stock_threshold',
      isActive: 'is_active',
      isFeatured: 'is_featured',
      weight: 'weight',
      tags: 'tags',
      metadata: 'metadata',
      slug: 'slug',
    };

    for (const [key, dbField] of Object.entries(fieldMap)) {
      if (value[key] !== undefined) {
        fields.push(`${dbField} = $${paramIndex++}`);
        params.push(value[key]);
      }
    }

    if (fields.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'NO_UPDATE_FIELDS',
          message: 'Aucun champ à mettre à jour.',
        },
        requestId: req.requestId,
      });
    }

    params.push(id);
    const updateQuery = `
      UPDATE products SET ${fields.join(', ')}
      WHERE id = $${paramIndex}
      RETURNING *
    `;

    const result = await database.query(updateQuery, params);
    const product = formatProduct(result.rows[0]);

    // Clear caches
    await database.cacheDelete(`product:detail:${id}`);
    await database.cacheDelete('products:list:*');
    await database.cacheDelete('products:categories');

    // Log stock movement if stock changed
    if (value.stockQuantity !== undefined) {
      const oldStock = existing.rows[0].stock_quantity;
      const change = value.stockQuantity - oldStock;
      await database.query(`
        INSERT INTO stock_movements (product_id, quantity_change, previous_quantity, new_quantity, reason, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [id, change, oldStock, value.stockQuantity, 'adjustment', req.user.id]);
    }

    res.json({
      success: true,
      message: 'Produit mis à jour avec succès.',
      data: product,
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Products] Update error: ${error.message}`);

    if (error.code === '23505') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'DUPLICATE_ENTRY',
          message: 'Un produit avec ce nom ou SKU existe déjà.',
        },
        requestId: req.requestId,
      });
    }

    res.status(500).json({
      success: false,
      error: {
        code: 'PRODUCT_UPDATE_ERROR',
        message: 'Erreur lors de la mise à jour du produit.',
      },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// PATCH /api/products/:id/stock - Update stock (Admin only)
// ============================================================
router.patch('/:id/stock', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity, reason = 'adjustment', notes = '' } = req.body;

    if (typeof quantity !== 'number' || quantity < 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STOCK_QUANTITY',
          message: 'La quantité doit être un nombre positif.',
        },
        requestId: req.requestId,
      });
    }

    const validReasons = ['purchase', 'sale', 'adjustment', 'return', 'damage', 'transfer'];
    if (!validReasons.includes(reason)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_STOCK_REASON',
          message: `Raison invalide. Valeurs possibles: ${validReasons.join(', ')}`,
        },
        requestId: req.requestId,
      });
    }

    // Use transaction for atomic stock update
    const result = await database.transaction(async (client) => {
      // Get current stock
      const current = await client.query(
        'SELECT stock_quantity FROM products WHERE id = $1 FOR UPDATE',
        [id]
      );

      if (current.rows.length === 0) {
        const error = new Error('Product not found');
        error.statusCode = 404;
        throw error;
      }

      const oldQuantity = current.rows[0].stock_quantity;

      // Update stock
      const update = await client.query(
        'UPDATE products SET stock_quantity = $1 WHERE id = $2 RETURNING *',
        [quantity, id]
      );

      // Log movement
      await client.query(`
        INSERT INTO stock_movements (product_id, quantity_change, previous_quantity, new_quantity, reason, notes, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [id, quantity - oldQuantity, oldQuantity, quantity, reason, notes, req.user.id]);

      return update.rows[0];
    });

    const product = formatProduct(result);

    // Clear caches
    await database.cacheDelete(`product:detail:${id}`);
    await database.cacheDelete('products:list:*');

    res.json({
      success: true,
      message: 'Stock mis à jour avec succès.',
      data: product,
      stockMovement: {
        productId: id,
        newQuantity: quantity,
        reason,
      },
      requestId: req.requestId,
    });
  } catch (error) {
    if (error.statusCode === 404) {
      return res.status(404).json({
        success: false,
        error: { code: 'PRODUCT_NOT_FOUND', message: 'Produit non trouvé.' },
        requestId: req.requestId,
      });
    }

    console.error(`[Products] Stock update error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: { code: 'STOCK_UPDATE_ERROR', message: 'Erreur lors de la mise à jour du stock.' },
      requestId: req.requestId,
    });
  }
});

// ============================================================
// DELETE /api/products/:id - Delete a product (Admin only)
// ============================================================
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Check for existing orders with this product
    const orderCheck = await database.query(
      'SELECT COUNT(*) FROM order_items WHERE product_id = $1',
      [id]
    );

    if (parseInt(orderCheck.rows[0].count) > 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'PRODUCT_HAS_ORDERS',
          message: 'Ce produit ne peut pas être supprimé car il est lié à des commandes existantes. Désactivez-le à la place.',
          orderCount: parseInt(orderCheck.rows[0].count),
        },
        requestId: req.requestId,
      });
    }

    const result = await database.query('DELETE FROM products WHERE id = $1 RETURNING id, name', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: 'PRODUCT_NOT_FOUND', message: 'Produit non trouvé.' },
        requestId: req.requestId,
      });
    }

    // Clear all caches
    await database.cacheDelete(`product:detail:${id}`);
    await database.cacheDelete('products:list:*');
    await database.cacheDelete('products:categories');

    res.json({
      success: true,
      message: `Produit "${result.rows[0].name}" supprimé avec succès.`,
      requestId: req.requestId,
    });
  } catch (error) {
    console.error(`[Products] Delete error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: { code: 'PRODUCT_DELETE_ERROR', message: 'Erreur lors de la suppression du produit.' },
      requestId: req.requestId,
    });
  }
});

module.exports = router;
