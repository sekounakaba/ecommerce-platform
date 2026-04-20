# E-Commerce Platform

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)
![React](https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Stripe](https://img.shields.io/badge/Stripe-635BFF?style=for-the-badge&logo=stripe&logoColor=white)

</div>

## Description

Plateforme e-commerce complète avec gestion des stocks, panier, paiement Stripe sécurisé et tableau de bord admin. Architecture microservices avec API Gateway, JWT auth et Redis cache.

Cette plateforme a été conçue pour offrir une solution e-commerce robuste, scalable et sécurisée, capable de gérer un grand volume de transactions tout en maintenant des performances optimales grâce à une architecture microservices et un système de cache distribué.

## Fonctionnalités

### Client
- **Catalogue de produits** - Navigation, recherche avancée, filtres par catégorie/prix
- **Panier d'achat** - Gestion complète (ajout, modification, suppression, persistance)
- **Paiement sécurisé** - Intégration Stripe avec gestion des webhooks
- **Suivi de commandes** - Statut en temps réel et historique complet
- **Authentification** - Inscription, connexion, OAuth2 (Google, Facebook)
- **Profil utilisateur** - Gestion des adresses, préférences et historique

### Administration
- **Tableau de bord** - Statistiques de vente, graphiques en temps réel
- **Gestion des produits** - CRUD complet avec upload d'images
- **Gestion des commandes** - Traitement, mise à jour du statut, remboursements
- **Gestion des stocks** - Alertes de seuil bas, historique des mouvements
- **Gestion des utilisateurs** - Rôles, permissions, modération
- **Configuration** - Paramètres de la boutique, taxes, livraison

### Architecture Microservices
- **API Gateway** - Routage intelligent, rate limiting, load balancing
- **Service Auth** - Authentification JWT, refresh tokens, OAuth2
- **Service Produits** - Catalogue, recherche, gestion des stocks
- **Service Commandes** - Cycle de vie des commandes, historique
- **Cache Redis** - Sessions, panier, mise en cache des produits populaires
- **Message Queue** - Communication asynchrone entre microservices

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLIENTS                                    │
│         ┌──────────────┐        ┌──────────────┐                       │
│         │  React App   │        │  Mobile App  │                       │
│         │  (PWA Ready) │        │  (React Nav) │                       │
│         └──────┬───────┘        └──────┬───────┘                       │
└────────────────┼───────────────────────┼───────────────────────────────┘
                 │                       │
                 ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           NGINX (Reverse Proxy)                         │
│                    SSL Termination · Load Balancing                     │
│                    Rate Limiting · Static Assets                        │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          API GATEWAY (Express)                          │
│    ┌─────────────────────────────────────────────────────────────┐     │
│    │  JWT Validation │ Rate Limiter │ Request Logger │ CORS      │     │
│    └─────────────────────────────────────────────────────────────┘     │
│                                                                         │
│    /api/auth  ──────▶  AUTH SERVICE        (Port 3001)                 │
│    /api/products ──▶  PRODUCT SERVICE     (Port 3002)                 │
│    /api/orders ────▶  ORDER SERVICE       (Port 3003)                 │
│    /api/admin ─────▶  ADMIN SERVICE       (Port 3004)                 │
└────────┬──────────────────┬──────────────────┬──────────────────────────┘
         │                  │                  │
         ▼                  ▼                  ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  AUTH SERVICE   │ │ PRODUCT SERVICE │ │  ORDER SERVICE  │
│                 │ │                 │ │                 │
│ · JWT Tokens    │ │ · CRUD Products │ │ · Create Order  │
│ · Refresh Token │ │ · Search/Filter │ │ · Stripe Pay    │
│ · OAuth2        │ │ · Stock Mgmt    │ │ · Webhooks      │
│ · User Profile  │ │ · Categories    │ │ · Status Track  │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           DATA LAYER                                    │
│                                                                         │
│   ┌───────────────┐         ┌───────────────┐         ┌────────────┐  │
│   │   PostgreSQL   │         │     Redis     │         │   Stripe   │  │
│   │  (Primary DB)  │         │   (Cache)     │         │   (Payment)│  │
│   │                │         │               │         │            │  │
│   │ · Users        │         │ · Sessions    │         │ · Charges  │  │
│   │ · Products     │         │ · Cart        │         │ · Refunds  │  │
│   │ · Orders       │         │ · Rate Limit  │         │ · Webhooks │  │
│   │ · Transactions │         │ · Product Qty │         │ · Invoices │  │
│   └───────────────┘         └───────────────┘         └────────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Technologie | Usage |
|-------------|-------|
| **React 18** | Frontend avec Next.js, Zustand pour le state |
| **Node.js 20** | Runtime pour tous les microservices |
| **Express.js** | Framework API pour chaque service |
| **PostgreSQL 16** | Base de données relationnelle principale |
| **Redis 7** | Cache distribué, sessions, rate limiting |
| **Docker & Docker Compose** | Conteneurisation et orchestration |
| **Stripe** | Paiements sécurisés, webhooks, refunds |
| **JWT (jsonwebtoken)** | Authentification stateless |
| **Winston** | Logging structuré |
| **Joi** | Validation des schémas de données |
| **Nginx** | Reverse proxy et load balancing |

## Prérequis

- **Node.js** >= 20.x
- **Docker** >= 24.x
- **Docker Compose** >= 2.20.x
- **PostgreSQL** >= 16 (si exécution hors Docker)
- **Redis** >= 7 (si exécution hors Docker)
- **Compte Stripe** (pour les paiements)

## Installation

### 1. Cloner le repository

```bash
git clone https://github.com/sekounakaba/ecommerce-platform.git
cd ecommerce-platform
```

### 2. Configurer les variables d'environnement

```bash
cp .env.example .env
# Éditez .env avec vos configurations (clés Stripe, DB, etc.)
```

### 3. Lancer avec Docker (recommandé)

```bash
docker-compose up -d --build
```

### 4. Lancer en développement local

```bash
# Installer les dépendances
npm install

# Créer la base de données
npm run db:create
npm run db:migrate

# Démarrer en mode développement
npm run dev

# Le serveur démarre sur http://localhost:3000
```

### 5. Initialiser les données de test

```bash
npm run seed
```

## API Endpoints

### Authentication (`/api/auth`)

| Méthode | Endpoint | Description | Auth |
|---------|----------|-------------|------|
| `POST` | `/api/auth/register` | Inscription d'un nouvel utilisateur | Non |
| `POST` | `/api/auth/login` | Connexion | Non |
| `POST` | `/api/auth/refresh` | Rafraîchir le token JWT | Oui |
| `POST` | `/api/auth/logout` | Déconnexion | Oui |
| `POST` | `/api/auth/forgot-password` | Demande de réinitialisation | Non |
| `POST` | `/api/auth/reset-password` | Réinitialisation du mot de passe | Non |
| `GET` | `/api/auth/me` | Profil de l'utilisateur connecté | Oui |

### Products (`/api/products`)

| Méthode | Endpoint | Description | Auth |
|---------|----------|-------------|------|
| `GET` | `/api/products` | Liste des produits (pagination, filtres) | Non |
| `GET` | `/api/products/:id` | Détail d'un produit | Non |
| `GET` | `/api/products/search` | Recherche full-text | Non |
| `GET` | `/api/products/categories` | Liste des catégories | Non |
| `POST` | `/api/products` | Créer un produit | Admin |
| `PUT` | `/api/products/:id` | Modifier un produit | Admin |
| `DELETE` | `/api/products/:id` | Supprimer un produit | Admin |
| `PATCH` | `/api/products/:id/stock` | Mettre à jour le stock | Admin |

### Orders (`/api/orders`)

| Méthode | Endpoint | Description | Auth |
|---------|----------|-------------|------|
| `POST` | `/api/orders` | Créer une commande | Oui |
| `GET` | `/api/orders` | Liste des commandes utilisateur | Oui |
| `GET` | `/api/orders/:id` | Détail d'une commande | Oui |
| `POST` | `/api/orders/:id/pay` | Payer avec Stripe | Oui |
| `POST` | `/api/orders/:id/cancel` | Annuler une commande | Oui |
| `POST` | `/api/webhooks/stripe` | Webhook Stripe | Stripe |

### Cart (`/api/cart`)

| Méthode | Endpoint | Description | Auth |
|---------|----------|-------------|------|
| `GET` | `/api/cart` | Récupérer le panier | Oui |
| `POST` | `/api/cart/items` | Ajouter un article | Oui |
| `PUT` | `/api/cart/items/:id` | Modifier la quantité | Oui |
| `DELETE` | `/api/cart/items/:id` | Supprimer un article | Oui |
| `DELETE` | `/api/cart` | Vider le panier | Oui |

### Admin (`/api/admin`)

| Méthode | Endpoint | Description | Auth |
|---------|----------|-------------|------|
| `GET` | `/api/admin/dashboard` | Statistiques du tableau de bord | Admin |
| `GET` | `/api/admin/users` | Liste des utilisateurs | Admin |
| `GET` | `/api/admin/orders` | Toutes les commandes | Admin |
| `PATCH` | `/api/admin/orders/:id/status` | Mettre à jour le statut | Admin |
| `GET` | `/api/admin/analytics` | Analyses de vente | Admin |

## Scripts Disponibles

```bash
npm run dev          # Démarrer en mode développement (nodemon)
npm run start        # Démarrer en mode production
npm run test         # Lancer les tests unitaires
npm run test:e2e     # Lancer les tests end-to-end
npm run lint         # Linter avec ESLint
npm run db:create    # Créer la base de données
npm run db:migrate   # Lancer les migrations
npm run db:seed      | Peupler la base de données
npm run docker:up    # Démarrer les services Docker
npm run docker:down  # Arrêter les services Docker
```

## Structure du Projet

```
ecommerce-platform/
├── docker/
│   ├── nginx/
│   │   └── nginx.conf            # Configuration Nginx
│   └── postgres/
│       └── init.sql              # Script d'initialisation DB
├── src/
│   ├── config/
│   │   ├── database.js           # Configuration PostgreSQL
│   │   ├── redis.js              # Configuration Redis
│   │   └── stripe.js             # Configuration Stripe
│   ├── middleware/
│   │   ├── auth.js               # Middleware JWT
│   │   ├── errorHandler.js       # Gestion centralisée des erreurs
│   │   ├── rateLimiter.js        # Rate limiting
│   │   └── validator.js          # Validation des requêtes
│   ├── models/
│   │   ├── User.js               # Modèle Utilisateur
│   │   ├── Product.js            # Modèle Produit
│   │   └── Order.js              # Modèle Commande
│   ├── routes/
│   │   ├── auth.js               # Routes d'authentification
│   │   ├── products.js           # Routes des produits
│   │   ├── orders.js             # Routes des commandes
│   │   └── cart.js               # Routes du panier
│   ├── services/
│   │   ├── authService.js        # Logique métier auth
│   │   ├── productService.js     # Logique métier produits
│   │   └── orderService.js       # Logique métier commandes
│   ├── utils/
│   │   ├── logger.js             # Configuration Winston
│   │   └── helpers.js            # Fonctions utilitaires
│   └── server.js                 # Point d'entrée principal
├── scripts/
│   └── seed.js                   # Données de test
├── tests/
│   ├── unit/
│   └── integration/
├── docker-compose.yml            # Orchestration Docker
├── Dockerfile                    # Image Docker de l'API
├── package.json                  # Dépendances et scripts
├── .env.example                  # Template des variables d'environnement
├── .eslintrc.js                  # Configuration ESLint
└── README.md                     # Documentation
```

## Configuration Stripe

1. Créez un compte sur [stripe.com](https://stripe.com)
2. Récupérez vos clés API depuis le dashboard
3. Configurez les webhooks Stripe pour `/api/webhooks/stripe`
4. Événements à écouter :
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.refunded`

## Tests

```bash
# Tests unitaires
npm run test

# Tests avec couverture
npm run test:coverage

# Tests end-to-end
npm run test:e2e
```

## Déploiement

Le projet est préconfiguré pour un déploiement sur :

- **Docker** - Conteneurisation complète
- **AWS ECS** - Configuration Terraform disponible
- **Railway** - Déploiement simplifié

```bash
# Déploiement Docker en production
docker-compose -f docker-compose.prod.yml up -d
```

## Auteur

**Sekouna KABA**
- Développeur Full-Stack
- Portfolio: [github.com/sekounakaba](https://github.com/sekounakaba)

## Licence

Ce projet est sous licence MIT. Consultez le fichier [LICENSE](LICENSE) pour plus de détails.

---

<div align="center">
Construit avec passion par <strong>Sekouna KABA</strong>
</div>
