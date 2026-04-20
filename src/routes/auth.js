const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const Joi = require('joi');
const database = require('../config/database');
const {
  authenticate,
  requireAdmin,
  generateTokenPair,
  verifyToken,
} = require('../middleware/auth');

function createAuthRoutes(rateLimiter) {
  const router = express.Router();

  // ============================================================
  // Validation Schemas
  // ============================================================
  const registerSchema = Joi.object({
    email: Joi.string().email().required().messages({
      'string.email': 'Adresse email invalide.',
      'any.required': 'L\'adresse email est requise.',
    }),
    password: Joi.string().min(8).max(128).pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).required().messages({
      'string.min': 'Le mot de passe doit contenir au moins 8 caractères.',
      'string.max': 'Le mot de passe ne peut pas dépasser 128 caractères.',
      'string.pattern.base': 'Le mot de passe doit contenir au moins une majuscule, une minuscule et un chiffre.',
      'any.required': 'Le mot de passe est requis.',
    }),
    firstName: Joi.string().min(2).max(100).required().messages({
      'string.min': 'Le prénom doit contenir au moins 2 caractères.',
      'any.required': 'Le prénom est requis.',
    }),
    lastName: Joi.string().min(2).max(100).required().messages({
      'string.min': 'Le nom doit contenir au moins 2 caractères.',
      'any.required': 'Le nom est requis.',
    }),
    phone: Joi.string().max(20).allow('').optional(),
  });

  const loginSchema = Joi.object({
    email: Joi.string().email().required().messages({
      'string.email': 'Adresse email invalide.',
      'any.required': 'L\'adresse email est requise.',
    }),
    password: Joi.string().required().messages({
      'any.required': 'Le mot de passe est requis.',
    }),
    rememberMe: Joi.boolean().default(false),
  });

  const forgotPasswordSchema = Joi.object({
    email: Joi.string().email().required(),
  });

  const resetPasswordSchema = Joi.object({
    token: Joi.string().required(),
    password: Joi.string().min(8).max(128).pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).required(),
  });

  const updateProfileSchema = Joi.object({
    firstName: Joi.string().min(2).max(100).optional(),
    lastName: Joi.string().min(2).max(100).optional(),
    phone: Joi.string().max(20).allow('').optional(),
    avatarUrl: Joi.string().uri().allow('').optional(),
  });

  const changePasswordSchema = Joi.object({
    currentPassword: Joi.string().required(),
    newPassword: Joi.string().min(8).max(128).pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).required(),
  });

  // ============================================================
  // POST /api/auth/register - User registration
  // ============================================================
  router.post('/register', rateLimiter, async (req, res) => {
    try {
      const { error, value } = registerSchema.validate(req.body);
      if (error) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Données d\'inscription invalides.',
            details: error.details.map(d => ({ field: d.path.join('.'), message: d.message })),
          },
          requestId: req.requestId,
        });
      }

      // Check if user already exists
      const existingUser = await database.query(
        'SELECT id, email FROM users WHERE email = $1',
        [value.email.toLowerCase()]
      );

      if (existingUser.rows.length > 0) {
        return res.status(409).json({
          success: false,
          error: {
            code: 'USER_ALREADY_EXISTS',
            message: 'Un compte avec cette adresse email existe déjà.',
          },
          requestId: req.requestId,
        });
      }

      // Hash password
      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(value.password, saltRounds);

      // Create user
      const userId = uuidv4();
      const result = await database.query(`
        INSERT INTO users (id, email, password_hash, first_name, last_name, phone)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, email, first_name, last_name, phone, role, is_active, email_verified, created_at
      `, [userId, value.email.toLowerCase(), passwordHash, value.firstName, value.lastName, value.phone || null]);

      const user = result.rows[0];

      // Generate tokens
      const tokens = generateTokenPair(user);

      // Store refresh token in Redis
      await database.cacheSet(
        `refresh_token:${user.id}`,
        tokens.refreshToken,
        7 * 24 * 60 * 60 // 7 days in seconds
      );

      res.status(201).json({
        success: true,
        message: 'Compte créé avec succès.',
        data: {
          user: {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            role: user.role,
          },
          tokens,
        },
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(`[Auth] Register error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'REGISTER_ERROR', message: 'Erreur lors de la création du compte.' },
        requestId: req.requestId,
      });
    }
  });

  // ============================================================
  // POST /api/auth/login - User login
  // ============================================================
  router.post('/login', rateLimiter, async (req, res) => {
    try {
      const { error, value } = loginSchema.validate(req.body);
      if (error) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Données de connexion invalides.',
            details: error.details.map(d => ({ field: d.path.join('.'), message: d.message })),
          },
          requestId: req.requestId,
        });
      }

      // Find user
      const result = await database.query(
        'SELECT * FROM users WHERE email = $1',
        [value.email.toLowerCase()]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Email ou mot de passe incorrect.' },
          requestId: req.requestId,
        });
      }

      const user = result.rows[0];

      // Check if account is active
      if (!user.is_active) {
        return res.status(403).json({
          success: false,
          error: { code: 'ACCOUNT_DISABLED', message: 'Votre compte a été désactivé. Contactez le support.' },
          requestId: req.requestId,
        });
      }

      // Verify password
      const isPasswordValid = await bcrypt.compare(value.password, user.password_hash);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CREDENTIALS', message: 'Email ou mot de passe incorrect.' },
          requestId: req.requestId,
        });
      }

      // Update last login
      await database.query(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
        [user.id]
      );

      // Generate tokens
      const tokens = generateTokenPair(user);

      // Store refresh token in Redis
      const refreshTTL = value.rememberMe ? 30 * 24 * 60 * 60 : 7 * 24 * 60 * 60;
      await database.cacheSet(`refresh_token:${user.id}`, tokens.refreshToken, refreshTTL);

      res.json({
        success: true,
        message: 'Connexion réussie.',
        data: {
          user: {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            phone: user.phone,
            role: user.role,
            emailVerified: user.email_verified,
            avatarUrl: user.avatar_url,
          },
          tokens,
        },
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(`[Auth] Login error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'LOGIN_ERROR', message: 'Erreur lors de la connexion.' },
        requestId: req.requestId,
      });
    }
  });

  // ============================================================
  // POST /api/auth/refresh - Refresh access token
  // ============================================================
  router.post('/refresh', async (req, res) => {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          error: { code: 'REFRESH_TOKEN_REQUIRED', message: 'Le refresh token est requis.' },
          requestId: req.requestId,
        });
      }

      // Verify refresh token
      let decoded;
      try {
        decoded = verifyToken(refreshToken);
      } catch (error) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_REFRESH_TOKEN', message: 'Refresh token invalide ou expiré.' },
          requestId: req.requestId,
        });
      }

      if (decoded.type !== 'refresh') {
        return res.status(401).json({
          success: false,
          error: { code: 'WRONG_TOKEN_TYPE', message: 'Token invalide. Un refresh token est requis.' },
          requestId: req.requestId,
        });
      }

      // Check stored refresh token
      const storedToken = await database.cacheGet(`refresh_token:${decoded.sub}`);
      if (storedToken !== refreshToken) {
        // Token reuse detected - invalidate all tokens for this user
        await database.cacheDelete(`refresh_token:${decoded.sub}`);
        return res.status(401).json({
          success: false,
          error: { code: 'TOKEN_REUSE_DETECTED', message: 'Suspicion de réutilisation de token. Veuillez vous reconnecter.' },
          requestId: req.requestId,
        });
      }

      // Get user from database
      const userResult = await database.query(
        'SELECT * FROM users WHERE id = $1 AND is_active = true',
        [decoded.sub]
      );

      if (userResult.rows.length === 0) {
        await database.cacheDelete(`refresh_token:${decoded.sub}`);
        return res.status(401).json({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'Utilisateur non trouvé ou désactivé.' },
          requestId: req.requestId,
        });
      }

      const user = userResult.rows[0];

      // Generate new token pair
      const tokens = generateTokenPair(user);
      await database.cacheSet(`refresh_token:${user.id}`, tokens.refreshToken, 7 * 24 * 60 * 60);

      res.json({
        success: true,
        data: tokens,
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(`[Auth] Refresh error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'TOKEN_REFRESH_ERROR', message: 'Erreur lors du rafraîchissement du token.' },
        requestId: req.requestId,
      });
    }
  });

  // ============================================================
  // GET /api/auth/me - Get current user profile
  // ============================================================
  router.get('/me', authenticate, async (req, res) => {
    try {
      const result = await database.query(
        `SELECT id, email, first_name, last_name, phone, role,
                is_active, email_verified, avatar_url, stripe_customer_id,
                last_login, created_at
         FROM users WHERE id = $1`,
        [req.user.id]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'Utilisateur non trouvé.' },
          requestId: req.requestId,
        });
      }

      const user = result.rows[0];

      // Get order summary
      const orderStats = await database.query(`
        SELECT
          COUNT(*) as total_orders,
          COALESCE(SUM(CASE WHEN status NOT IN ('cancelled', 'refunded') THEN total ELSE 0 END), 0) as total_spent
        FROM orders WHERE user_id = $1
      `, [req.user.id]);

      res.json({
        success: true,
        data: {
          user: {
            id: user.id,
            email: user.email,
            firstName: user.first_name,
            lastName: user.last_name,
            phone: user.phone,
            role: user.role,
            isActive: user.is_active,
            emailVerified: user.email_verified,
            avatarUrl: user.avatar_url,
            lastLogin: user.last_login,
            createdAt: user.created_at,
          },
          stats: {
            totalOrders: parseInt(orderStats.rows[0].total_orders),
            totalSpent: parseFloat(orderStats.rows[0].total_spent),
          },
        },
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(`[Auth] Get profile error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'PROFILE_ERROR', message: 'Erreur lors de la récupération du profil.' },
        requestId: req.requestId,
      });
    }
  });

  // ============================================================
  // PUT /api/auth/me - Update user profile
  // ============================================================
  router.put('/me', authenticate, async (req, res) => {
    try {
      const { error, value } = updateProfileSchema.validate(req.body);
      if (error) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Données invalides.', details: error.details },
          requestId: req.requestId,
        });
      }

      const fields = [];
      const params = [];
      let paramIndex = 1;

      const fieldMap = {
        firstName: 'first_name',
        lastName: 'last_name',
        phone: 'phone',
        avatarUrl: 'avatar_url',
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
          error: { code: 'NO_UPDATE_FIELDS', message: 'Aucun champ à mettre à jour.' },
          requestId: req.requestId,
        });
      }

      params.push(req.user.id);
      const result = await database.query(
        `UPDATE users SET ${fields.join(', ')} WHERE id = $${paramIndex}
         RETURNING id, email, first_name, last_name, phone, avatar_url, updated_at`,
        params
      );

      res.json({
        success: true,
        message: 'Profil mis à jour avec succès.',
        data: result.rows[0],
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(`[Auth] Update profile error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'PROFILE_UPDATE_ERROR', message: 'Erreur lors de la mise à jour du profil.' },
        requestId: req.requestId,
      });
    }
  });

  // ============================================================
  // POST /api/auth/change-password - Change password
  // ============================================================
  router.post('/change-password', authenticate, async (req, res) => {
    try {
      const { error, value } = changePasswordSchema.validate(req.body);
      if (error) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Données invalides.', details: error.details },
          requestId: req.requestId,
        });
      }

      const userResult = await database.query(
        'SELECT password_hash FROM users WHERE id = $1',
        [req.user.id]
      );

      const isCurrentPasswordValid = await bcrypt.compare(
        value.currentPassword,
        userResult.rows[0].password_hash
      );

      if (!isCurrentPasswordValid) {
        return res.status(401).json({
          success: false,
          error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Mot de passe actuel incorrect.' },
          requestId: req.requestId,
        });
      }

      const newPasswordHash = await bcrypt.hash(value.newPassword, 12);
      await database.query(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [newPasswordHash, req.user.id]
      );

      res.json({
        success: true,
        message: 'Mot de passe modifié avec succès.',
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(`[Auth] Change password error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'PASSWORD_CHANGE_ERROR', message: 'Erreur lors du changement de mot de passe.' },
        requestId: req.requestId,
      });
    }
  });

  // ============================================================
  // POST /api/auth/logout - Logout (invalidate refresh token)
  // ============================================================
  router.post('/logout', authenticate, async (req, res) => {
    try {
      await database.cacheDelete(`refresh_token:${req.user.id}`);

      res.json({
        success: true,
        message: 'Déconnexion réussie.',
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(`[Auth] Logout error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'LOGOUT_ERROR', message: 'Erreur lors de la déconnexion.' },
        requestId: req.requestId,
      });
    }
  });

  // ============================================================
  // POST /api/auth/forgot-password - Request password reset
  // ============================================================
  router.post('/forgot-password', rateLimiter, async (req, res) => {
    try {
      const { error, value } = forgotPasswordSchema.validate(req.body);
      if (error) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Email invalide.' },
          requestId: req.requestId,
        });
      }

      const result = await database.query(
        'SELECT id, email FROM users WHERE email = $1 AND is_active = true',
        [value.email.toLowerCase()]
      );

      if (result.rows.length === 0) {
        // Always return success to prevent email enumeration
        return res.json({
          success: true,
          message: 'Si un compte existe avec cet email, un email de réinitialisation a été envoyé.',
          requestId: req.requestId,
        });
      }

      const user = result.rows[0];
      const resetToken = uuidv4();

      await database.query(`
        UPDATE users SET
          reset_password_token = $1,
          reset_password_expires = CURRENT_TIMESTAMP + INTERVAL '1 hour'
        WHERE id = $2
      `, [resetToken, user.id]);

      // TODO: Send reset email via email service (e.g., SendGrid, AWS SES)
      console.log(`[Auth] Password reset token for ${user.email}: ${resetToken}`);

      res.json({
        success: true,
        message: 'Si un compte existe avec cet email, un email de réinitialisation a été envoyé.',
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(`[Auth] Forgot password error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'FORGOT_PASSWORD_ERROR', message: 'Erreur lors de la demande de réinitialisation.' },
        requestId: req.requestId,
      });
    }
  });

  // ============================================================
  // POST /api/auth/reset-password - Reset password with token
  // ============================================================
  router.post('/reset-password', async (req, res) => {
    try {
      const { error, value } = resetPasswordSchema.validate(req.body);
      if (error) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Données invalides.', details: error.details },
          requestId: req.requestId,
        });
      }

      const result = await database.query(
        `SELECT id, email FROM users
         WHERE reset_password_token = $1
           AND reset_password_expires > CURRENT_TIMESTAMP
           AND is_active = true`,
        [value.token]
      );

      if (result.rows.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_RESET_TOKEN', message: 'Token de réinitialisation invalide ou expiré.' },
          requestId: req.requestId,
        });
      }

      const user = result.rows[0];
      const passwordHash = await bcrypt.hash(value.password, 12);

      await database.query(`
        UPDATE users SET
          password_hash = $1,
          reset_password_token = NULL,
          reset_password_expires = NULL
        WHERE id = $2
      `, [passwordHash, user.id]);

      res.json({
        success: true,
        message: 'Mot de passe réinitialisé avec succès. Vous pouvez maintenant vous connecter.',
        requestId: req.requestId,
      });
    } catch (error) {
      console.error(`[Auth] Reset password error: ${error.message}`);
      res.status(500).json({
        success: false,
        error: { code: 'RESET_PASSWORD_ERROR', message: 'Erreur lors de la réinitialisation.' },
        requestId: req.requestId,
      });
    }
  });

  return router;
}

module.exports = createAuthRoutes;
