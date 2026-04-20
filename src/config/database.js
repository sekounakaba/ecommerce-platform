const { Pool } = require('pg');
const { createClient } = require('redis');

// ============================================================
// PostgreSQL Configuration & Connection Pool
// ============================================================
class Database {
  constructor() {
    this.pool = null;
    this.redisClient = null;
    this.isConnected = false;
  }

  /**
   * Initialize PostgreSQL connection pool
   */
  async connect() {
    const config = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'ecommerce_db',
      user: process.env.DB_USER || 'ecommerce_user',
      password: process.env.DB_PASSWORD || 'ecommerce_secure_password_2024',
      // Connection pool settings
      min: parseInt(process.env.DB_POOL_MIN) || 2,
      max: parseInt(process.env.DB_POOL_MAX) || 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      maxUses: 7500, // Recycle connections after 7500 uses
      allowExitOnIdle: false,
    };

    // SSL configuration for production
    if (process.env.NODE_ENV === 'production') {
      config.ssl = {
        rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true',
        ca: process.env.DB_SSL_CA || undefined,
      };
    }

    try {
      this.pool = new Pool(config);

      // Pool error handler
      this.pool.on('error', (err) => {
        console.error(`[DB] Unexpected pool error: ${err.message}`);
        this.isConnected = false;
      });

      // Test the connection
      const client = await this.pool.connect();
      await client.query('SELECT NOW()');
      client.release();

      this.isConnected = true;
      console.log(`[DB] PostgreSQL connected successfully to ${config.host}:${config.port}/${config.database}`);

      // Initialize tables
      await this.initializeTables();
    } catch (error) {
      console.error(`[DB] PostgreSQL connection failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Initialize Redis client for caching
   */
  async connectRedis() {
    try {
      this.redisClient = createClient({
        url: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`,
        password: process.env.REDIS_PASSWORD || undefined,
        socket: {
          reconnectStrategy: (retries) => {
            const delay = Math.min(retries * 50, 2000);
            return delay;
          },
          connectTimeout: 5000,
        },
      });

      this.redisClient.on('error', (err) => {
        console.error(`[Redis] Client error: ${err.message}`);
      });

      this.redisClient.on('connect', () => {
        console.log('[Redis] Client connected');
      });

      await this.redisClient.connect();
      console.log('[Redis] Connected successfully');

      // Test connection
      await this.redisClient.set('ping', 'pong');
      const pong = await this.redisClient.get('ping');
      console.log(`[Redis] Connection test: ${pong}`);

    } catch (error) {
      console.error(`[Redis] Connection failed: ${error.message}`);
      console.warn('[Redis] Falling back to no-cache mode');
    }
  }

  /**
   * Create initial database tables if they don't exist
   */
  async initializeTables() {
    const createTablesSQL = `
      -- Enable UUID extension
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      -- ============================================================
      -- Users Table
      -- ============================================================
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        first_name VARCHAR(100) NOT NULL,
        last_name VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        role VARCHAR(20) DEFAULT 'customer' CHECK (role IN ('customer', 'admin', 'manager')),
        is_active BOOLEAN DEFAULT true,
        email_verified BOOLEAN DEFAULT false,
        avatar_url TEXT,
        stripe_customer_id VARCHAR(255),
        reset_password_token VARCHAR(255),
        reset_password_expires TIMESTAMP,
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- ============================================================
      -- Categories Table
      -- ============================================================
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        slug VARCHAR(100) UNIQUE NOT NULL,
        description TEXT,
        parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        image_url TEXT,
        is_active BOOLEAN DEFAULT true,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Create index on slug for fast lookups
      CREATE INDEX IF NOT EXISTS idx_categories_slug ON categories(slug);

      -- ============================================================
      -- Products Table
      -- ============================================================
      CREATE TABLE IF NOT EXISTS products (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) UNIQUE NOT NULL,
        description TEXT,
        short_description VARCHAR(500),
        sku VARCHAR(50) UNIQUE,
        price DECIMAL(10, 2) NOT NULL CHECK (price >= 0),
        compare_at_price DECIMAL(10, 2),
        cost_price DECIMAL(10, 2),
        category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
        images TEXT[] DEFAULT '{}',
        stock_quantity INTEGER DEFAULT 0 CHECK (stock_quantity >= 0),
        low_stock_threshold INTEGER DEFAULT 10,
        is_active BOOLEAN DEFAULT true,
        is_featured BOOLEAN DEFAULT false,
        weight DECIMAL(8, 2),
        dimensions JSONB DEFAULT '{}',
        tags TEXT[] DEFAULT '{}',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes for product queries
      CREATE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
      CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
      CREATE INDEX IF NOT EXISTS idx_products_active ON products(is_active);
      CREATE INDEX IF NOT EXISTS idx_products_featured ON products(is_featured);
      CREATE INDEX IF NOT EXISTS idx_products_price ON products(price);
      CREATE INDEX IF NOT EXISTS idx_products_name_search ON products USING gin(to_tsvector('french', name));
      CREATE INDEX IF NOT EXISTS idx_products_desc_search ON products USING gin(to_tsvector('french', description));

      -- ============================================================
      -- Orders Table
      -- ============================================================
      CREATE TABLE IF NOT EXISTS orders (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_number VARCHAR(20) UNIQUE NOT NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN (
          'pending', 'confirmed', 'processing', 'shipped',
          'delivered', 'cancelled', 'refunded', 'failed'
        )),
        subtotal DECIMAL(10, 2) NOT NULL CHECK (subtotal >= 0),
        tax_amount DECIMAL(10, 2) DEFAULT 0 CHECK (tax_amount >= 0),
        shipping_amount DECIMAL(10, 2) DEFAULT 0 CHECK (shipping_amount >= 0),
        discount_amount DECIMAL(10, 2) DEFAULT 0 CHECK (discount_amount >= 0),
        total DECIMAL(10, 2) NOT NULL CHECK (total >= 0),
        currency VARCHAR(3) DEFAULT 'EUR',
        shipping_address JSONB NOT NULL,
        billing_address JSONB,
        stripe_payment_intent_id VARCHAR(255),
        stripe_charge_id VARCHAR(255),
        paid_at TIMESTAMP,
        shipped_at TIMESTAMP,
        delivered_at TIMESTAMP,
        cancelled_at TIMESTAMP,
        notes TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Indexes for order queries
      CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE INDEX IF NOT EXISTS idx_orders_number ON orders(order_number);
      CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

      -- ============================================================
      -- Order Items Table
      -- ============================================================
      CREATE TABLE IF NOT EXISTS order_items (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        product_name VARCHAR(255) NOT NULL,
        product_sku VARCHAR(50),
        product_image TEXT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        unit_price DECIMAL(10, 2) NOT NULL CHECK (unit_price >= 0),
        total_price DECIMAL(10, 2) NOT NULL CHECK (total_price >= 0),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
      CREATE INDEX IF NOT EXISTS idx_order_items_product ON order_items(product_id);

      -- ============================================================
      -- Stock Movements Table (Audit Trail)
      -- ============================================================
      CREATE TABLE IF NOT EXISTS stock_movements (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        quantity_change INTEGER NOT NULL,
        previous_quantity INTEGER NOT NULL,
        new_quantity INTEGER NOT NULL,
        reason VARCHAR(50) NOT NULL CHECK (reason IN (
          'purchase', 'sale', 'adjustment', 'return', 'damage', 'transfer'
        )),
        reference_id UUID,
        notes TEXT,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
      CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements(created_at DESC);

      -- ============================================================
      -- Updated_at Trigger Function
      -- ============================================================
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';

      -- Apply trigger to all tables with updated_at
      DO $$
      DECLARE
        tbl TEXT;
      BEGIN
        FOR tbl IN SELECT table_name FROM information_schema.columns
                    WHERE column_name = 'updated_at'
                      AND table_schema = 'public'
        LOOP
          EXECUTE format(
            'CREATE TRIGGER set_updated_at
             BEFORE UPDATE ON %I
             FOR EACH ROW
             EXECUTE FUNCTION update_updated_at_column()',
            tbl
          );
        END LOOP;
      END;
      $$;
    `;

    await this.pool.query(createTablesSQL);
    console.log('[DB] Database tables initialized successfully');
  }

  /**
   * Execute a SQL query with parameterized values
   * @param {string} text - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Object>} Query result
   */
  async query(text, params = []) {
    if (!this.pool) {
      throw new Error('Database pool is not initialized. Call connect() first.');
    }

    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      const duration = Date.now() - start;

      if (process.env.NODE_ENV === 'development') {
        console.log(`[DB] Query executed in ${duration}ms - Rows: ${result.rowCount}`);
      }

      return result;
    } catch (error) {
      console.error(`[DB] Query error: ${error.message}`);
      console.error(`[DB] Query: ${text}`);
      console.error(`[DB] Params: ${JSON.stringify(params)}`);
      throw error;
    }
  }

  /**
   * Execute a query within a transaction
   * @param {Function} callback - Async function receiving the client
   * @returns {Promise<any>} Result of the callback
   */
  async transaction(callback) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Test database connectivity
   * @returns {Promise<boolean>}
   */
  async ping() {
    try {
      if (!this.pool) return false;
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get Redis cached value
   * @param {string} key
   * @returns {Promise<string|null>}
   */
  async cacheGet(key) {
    try {
      if (!this.redisClient || !this.redisClient.isOpen) return null;
      const value = await this.redisClient.get(key);
      return value ? JSON.parse(value) : null;
    } catch {
      return null;
    }
  }

  /**
   * Set Redis cache value with TTL
   * @param {string} key
   * @param {*} value
   * @param {number} ttlSeconds - Time to live in seconds
   */
  async cacheSet(key, value, ttlSeconds = 3600) {
    try {
      if (!this.redisClient || !this.redisClient.isOpen) return;
      await this.redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
    } catch (error) {
      console.error(`[Redis] Cache set error: ${error.message}`);
    }
  }

  /**
   * Delete Redis cache key(s)
   * @param {string} pattern - Key or pattern to delete
   */
  async cacheDelete(pattern) {
    try {
      if (!this.redisClient || !this.redisClient.isOpen) return;
      if (pattern.includes('*')) {
        const keys = await this.redisClient.keys(pattern);
        if (keys.length > 0) {
          await this.redisClient.del(keys);
        }
      } else {
        await this.redisClient.del(pattern);
      }
    } catch (error) {
      console.error(`[Redis] Cache delete error: ${error.message}`);
    }
  }

  /**
   * Gracefully close all connections
   */
  async disconnect() {
    console.log('[DB] Closing database connections...');

    if (this.redisClient) {
      try {
        await this.redisClient.quit();
        console.log('[Redis] Client disconnected');
      } catch (err) {
        console.error(`[Redis] Disconnect error: ${err.message}`);
      }
    }

    if (this.pool) {
      try {
        await this.pool.end();
        console.log('[DB] PostgreSQL pool closed');
      } catch (err) {
        console.error(`[DB] Pool close error: ${err.message}`);
      }
    }

    this.isConnected = false;
  }
}

// Singleton instance
const database = new Database();

module.exports = database;
