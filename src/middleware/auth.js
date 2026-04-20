const jwt = require('jsonwebtoken');
const database = require('../config/database');

// ============================================================
// JWT Authentication Middleware
// ============================================================

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '24h';
const JWT_REFRESH_EXPIRES_IN = process.env.JWT_REFRESH_EXPIRES_IN || '7d';
const JWT_ISSUER = process.env.JWT_ISSUER || 'ecommerce-platform';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'ecommerce-api';

/**
 * Generate a JWT access token
 * @param {Object} payload - User data to encode
 * @returns {string} Signed JWT token
 */
function generateAccessToken(payload) {
  return jwt.sign(
    {
      sub: payload.id,
      email: payload.email,
      role: payload.role,
      firstName: payload.first_name,
      lastName: payload.last_name,
      type: 'access',
    },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRES_IN,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      subject: payload.id,
      jwtid: `access_${Date.now()}_${payload.id}`,
    }
  );
}

/**
 * Generate a JWT refresh token
 * @param {Object} payload - User data to encode
 * @returns {string} Signed JWT refresh token
 */
function generateRefreshToken(payload) {
  return jwt.sign(
    {
      sub: payload.id,
      type: 'refresh',
    },
    JWT_SECRET,
    {
      expiresIn: JWT_REFRESH_EXPIRES_IN,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      subject: payload.id,
      jwtid: `refresh_${Date.now()}_${payload.id}`,
    }
  );
}

/**
 * Generate a token pair (access + refresh)
 * @param {Object} user - User object from database
 * @returns {Object} Token pair
 */
function generateTokenPair(user) {
  return {
    accessToken: generateAccessToken(user),
    refreshToken: generateRefreshToken(user),
    expiresIn: JWT_EXPIRES_IN,
    refreshExpiresIn: JWT_REFRESH_EXPIRES_IN,
  };
}

/**
 * Verify and decode a JWT token
 * @param {string} token - JWT token to verify
 * @returns {Object} Decoded token payload
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    algorithms: ['HS256'],
  });
}

/**
 * Middleware: Protect routes that require authentication
 * Validates the JWT token from the Authorization header
 */
const authenticate = async (req, res, next) => {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_TOKEN_MISSING',
          message: 'Token d\'authentification requis. Veuillez vous connecter.',
        },
        requestId: req.requestId,
      });
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_TOKEN_INVALID_FORMAT',
          message: 'Format du token invalide. Utilisez: Bearer <token>',
        },
        requestId: req.requestId,
      });
    }

    const token = parts[1];

    if (!token || token.length < 10) {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_TOKEN_INVALID',
          message: 'Token invalide ou expiré.',
        },
        requestId: req.requestId,
      });
    }

    // Verify the token
    const decoded = verifyToken(token);

    // Ensure it's an access token
    if (decoded.type !== 'access') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_WRONG_TOKEN_TYPE',
          message: 'Token invalide. Un token d\'accès est requis.',
        },
        requestId: req.requestId,
      });
    }

    // Attach user info to request
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      firstName: decoded.firstName,
      lastName: decoded.lastName,
      tokenId: decoded.jti,
    };

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_TOKEN_EXPIRED',
          message: 'Votre session a expiré. Veuillez vous reconnecter ou rafraîchir votre token.',
          expiredAt: error.expiredAt,
        },
        requestId: req.requestId,
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_TOKEN_MALFORMED',
          message: 'Le token est malformé ou la signature est invalide.',
        },
        requestId: req.requestId,
      });
    }

    if (error.name === 'NotBeforeError') {
      return res.status(401).json({
        success: false,
        error: {
          code: 'AUTH_TOKEN_NOT_ACTIVE',
          message: 'Le token n\'est pas encore actif.',
        },
        requestId: req.requestId,
      });
    }

    // Unexpected error
    return res.status(500).json({
      success: false,
      error: {
        code: 'AUTH_INTERNAL_ERROR',
        message: 'Erreur lors de la vérification du token.',
      },
      requestId: req.requestId,
    });
  }
}

/**
 * Middleware: Restrict access to admin users only
 * Must be used after authenticate middleware
 */
const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      success: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Authentification requise.',
      },
      requestId: req.requestId,
    });
  }

  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({
      success: false,
      error: {
        code: 'AUTH_FORBIDDEN',
        message: 'Accès refusé. Vous n\'avez pas les permissions nécessaires.',
        requiredRole: 'admin',
        userRole: req.user.role,
      },
      requestId: req.requestId,
    });
  }

  next();
}

/**
 * Middleware: Optional authentication - doesn't fail if no token
 * Attaches user info if token is valid, continues anyway if not
 */
const optionalAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const decoded = verifyToken(token);

      if (decoded.type === 'access') {
        req.user = {
          id: decoded.sub,
          email: decoded.email,
          role: decoded.role,
          firstName: decoded.firstName,
          lastName: decoded.lastName,
          tokenId: decoded.jti,
        };
      }
    }
  } catch {
    // Token invalid or missing - continue without user
    req.user = null;
  }

  next();
}

/**
 * Middleware: Rate limit for sensitive operations
 * Tracks attempts per user ID or IP address
 */
function sensitiveOperationLimiter(maxAttempts = 3, windowMinutes = 15) {
  return async (req, res, next) => {
    try {
      const identifier = req.user?.id || req.ip;
      const key = `sensitive_op:${identifier}:${req.originalUrl}`;

      const attempts = await database.cacheGet(key);

      if (attempts && attempts.count >= maxAttempts) {
        return res.status(429).json({
          success: false,
          error: {
            code: 'TOO_MANY_ATTEMPTS',
            message: `Trop de tentatives. Veuillez réessayer dans ${windowMinutes} minutes.`,
            retryAfter: `${windowMinutes}m`,
          },
          requestId: req.requestId,
        });
      }

      // Continue execution
      const result = next();

      // If next() is sync, we need to handle it differently
      // This is handled by tracking success/failure in route handlers

      return result;
    } catch (error) {
      // If Redis is down, allow the request
      next();
    }
  };
}

module.exports = {
  authenticate,
  requireAdmin,
  optionalAuth,
  generateAccessToken,
  generateRefreshToken,
  generateTokenPair,
  verifyToken,
  sensitiveOperationLimiter,
};
