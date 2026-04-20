const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const hpp = require('hpp');
const rateLimit = require('express-rate-limit');
const path = require('path');
require('dotenv').config();

const database = require('./config/database');
const productRoutes = require('./routes/products');
const orderRoutes = require('./routes/orders');
const authMiddleware = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const SERVICE_NAME = process.env.SERVICE_NAME || 'api-gateway';

// ============================================================
// Trust proxy - Required behind Nginx / Load Balancer
// ============================================================
app.set('trust proxy', 1);

// ============================================================
// Security Middleware
// ============================================================
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://*.stripe.com"],
      connectSrc: ["'self'", "https://api.stripe.com"],
      frameSrc: ["'self'", "https://js.stripe.com"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
}));

// ============================================================
// CORS Configuration
// ============================================================
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = process.env.CORS_ORIGIN
      ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
      : ['http://localhost:3000', 'http://localhost:5000'];

    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.stripe.com')) {
      callback(null, true);
    } else {
      callback(new Error(`CORS policy: Origin ${origin} not allowed`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Request-Id',
    'X-Service-Name',
    'Stripe-Signature',
  ],
  credentials: true,
  maxAge: 86400, // 24 hours preflight cache
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ============================================================
// Body Parsing
// ============================================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================================
// HTTP Parameter Pollution Protection
// ============================================================
app.use(hpp());

// ============================================================
// Compression
// ============================================================
app.use(compression({
  level: 6,
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
}));

// ============================================================
// Rate Limiting
// ============================================================
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Trop de requêtes depuis cette adresse IP. Veuillez réessayer plus tard.',
      retryAfter: '15m',
    },
  },
  handler: (req, res, next, options) => {
    res.status(options.statusCode).json(options.message);
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Stricter for auth endpoints
  message: {
    success: false,
    error: {
      code: 'AUTH_RATE_LIMIT_EXCEEDED',
      message: 'Trop de tentatives de connexion. Veuillez réessayer dans 15 minutes.',
    },
  },
});

// Apply global rate limiter
app.use('/api/', globalLimiter);

// Apply stricter rate limiter to auth routes
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

// ============================================================
// Request Logging
// ============================================================
if (NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
  app.use(morgan('combined', {
    skip: (req, res) => res.statusCode < 400,
  }));
}

// ============================================================
// Request ID Middleware
// ============================================================
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Service-Name', SERVICE_NAME);
  res.setHeader('X-Response-Time', Date.now().toString());
  next();
});

// ============================================================
// API Routes
// ============================================================
app.use('/api/auth', require('./routes/auth')(authLimiter));
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);

// ============================================================
// Health Check Endpoint
// ============================================================
app.get('/health', async (req, res) => {
  const healthCheck = {
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    service: SERVICE_NAME,
    environment: NODE_ENV,
    version: process.env.npm_package_version || '2.1.0',
    memory: {
      rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
      heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
    },
  };

  try {
    const dbStatus = await database.ping();
    healthCheck.database = { status: dbStatus ? 'connected' : 'disconnected' };
  } catch (error) {
    healthCheck.database = { status: 'disconnected', error: error.message };
    healthCheck.status = 'DEGRADED';
  }

  const statusCode = healthCheck.status === 'OK' ? 200 : 503;
  res.status(statusCode).json(healthCheck);
});

// ============================================================
// API Documentation Redirect
// ============================================================
app.get('/api', (req, res) => {
  res.json({
    success: true,
    message: 'E-Commerce Platform API',
    version: '2.1.0',
    endpoints: {
      auth: {
        register: 'POST /api/auth/register',
        login: 'POST /api/auth/login',
        refresh: 'POST /api/auth/refresh',
        me: 'GET /api/auth/me',
      },
      products: {
        list: 'GET /api/products',
        detail: 'GET /api/products/:id',
        search: 'GET /api/products/search?q=keyword',
        create: 'POST /api/products',
        update: 'PUT /api/products/:id',
        delete: 'DELETE /api/products/:id',
      },
      orders: {
        create: 'POST /api/orders',
        list: 'GET /api/orders',
        detail: 'GET /api/orders/:id',
        pay: 'POST /api/orders/:id/pay',
        cancel: 'POST /api/orders/:id/cancel',
        webhook: 'POST /api/webhooks/stripe',
      },
    },
    health: 'GET /health',
  });
});

// ============================================================
// Stripe Webhook Endpoint (raw body required)
// ============================================================
app.use('/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  require('./routes/webhooks').stripeWebhook
);

// ============================================================
// 404 Handler
// ============================================================
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: 'NOT_FOUND',
      message: `La route ${req.method} ${req.originalUrl} n'existe pas sur ce serveur.`,
      suggestion: 'Consultez GET /api pour la liste des endpoints disponibles.',
    },
    requestId: req.requestId,
  });
});

// ============================================================
// Global Error Handler
// ============================================================
app.use((err, req, res, _next) => {
  const statusCode = err.statusCode || 500;
  const message = NODE_ENV === 'production' && statusCode === 500
    ? 'Une erreur interne du serveur est survenue.'
    : err.message;

  const errorResponse = {
    success: false,
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message,
      ...(NODE_ENV === 'development' && { stack: err.stack, details: err.details }),
    },
    requestId: req.requestId,
  };

  if (NODE_ENV === 'development') {
    console.error(`[${new Date().toISOString()}] [ERROR] ${err.message}`);
    console.error(err.stack);
  }

  res.status(statusCode).json(errorResponse);
});

// ============================================================
// Graceful Shutdown Handler
// ============================================================
const server = app.listen(PORT, async () => {
  try {
    await database.connect();
    console.log(`\n╔══════════════════════════════════════════════════════════╗`);
    console.log(`║          E-Commerce Platform - ${SERVICE_NAME.padEnd(22)}║`);
    console.log(`║                                                          ║`);
    console.log(`║  Environment:  ${NODE_ENV.padEnd(40)}║`);
    console.log(`║  Port:         ${String(PORT).padEnd(40)}║`);
    console.log(`║  API URL:      http://localhost:${String(PORT).padEnd(29)}║`);
    console.log(`║  Health:       http://localhost:${String(PORT)}/health${' '.repeat(22)}║`);
    console.log(`║  Docs:         http://localhost:${String(PORT)}/api${' '.repeat(26)}║`);
    console.log(`╚══════════════════════════════════════════════════════════╝\n`);
  } catch (error) {
    console.error('Failed to connect to database on startup:', error.message);
    process.exit(1);
  }
});

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

function gracefulShutdown(signal) {
  console.log(`\n${signal} received. Starting graceful shutdown...`);

  server.close(() => {
    console.log('HTTP server closed.');

    database.disconnect()
      .then(() => {
        console.log('Database connections closed.');
        process.exit(0);
      })
      .catch((err) => {
        console.error('Error closing database connections:', err);
        process.exit(1);
      });
  });

  // Force exit after 30 seconds
  setTimeout(() => {
    console.error('Forcing shutdown after timeout.');
    process.exit(1);
  }, 30000);
}

module.exports = app;
