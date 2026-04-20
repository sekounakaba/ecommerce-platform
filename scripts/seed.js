/**
 * Seed Script - Populate database with test data
 * Usage: node scripts/seed.js
 */

const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const database = require('../src/config/database');

async function seed() {
  console.log('🌱 Starting database seeding...\n');

  try {
    await database.connect();

    // ============================================================
    // 1. Create Admin User
    // ============================================================
    console.log('👤 Creating admin user...');
    const adminPassword = await bcrypt.hash('Admin123!', 12);

    const adminResult = await database.query(`
      INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_active, email_verified)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (email) DO NOTHING
      RETURNING id
    `, [
      uuidv4(),
      'admin@ecommerce-platform.com',
      adminPassword,
      'Admin',
      'E-Commerce',
      'admin',
      true,
      true,
    ]);
    console.log(`   ✓ Admin user created: admin@ecommerce-platform.com`);
    console.log(`     Password: Admin123!\n`);

    // ============================================================
    // 2. Create Test Customers
    // ============================================================
    console.log('👥 Creating test customers...');
    const customers = [
      { firstName: 'Jean', lastName: 'Dupont', email: 'jean.dupont@email.com' },
      { firstName: 'Marie', lastName: 'Martin', email: 'marie.martin@email.com' },
      { firstName: 'Pierre', lastName: 'Bernard', email: 'pierre.bernard@email.com' },
    ];

    for (const customer of customers) {
      const password = await bcrypt.hash('Customer123!', 12);
      await database.query(`
        INSERT INTO users (id, email, password_hash, first_name, last_name, role, is_active, email_verified)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (email) DO NOTHING
      `, [uuidv4(), customer.email, password, customer.firstName, customer.lastName, 'customer', true, true]);
      console.log(`   ✓ Customer: ${customer.email}`);
    }
    console.log(`     Password: Customer123!\n`);

    // ============================================================
    // 3. Create Categories
    // ============================================================
    console.log('📂 Creating categories...');
    const categories = [
      { name: 'Électronique', slug: 'electronique', description: 'Appareils électroniques et accessoires' },
      { name: 'Vêtements', slug: 'vetements', description: 'Mode et vêtements pour tous' },
      { name: 'Maison & Jardin', slug: 'maison-jardin', description: 'Articles pour la maison et le jardin' },
      { name: 'Sports & Loisirs', slug: 'sports-loisirs', description: 'Équipement sportif et articles de loisirs' },
      { name: 'Beauté & Santé', slug: 'beaute-sante', description: 'Produits de beauté et bien-être' },
    ];

    const categoryIds = {};
    for (const cat of categories) {
      const result = await database.query(`
        INSERT INTO categories (name, slug, description, is_active, sort_order)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (slug) DO NOTHING
        RETURNING id
      `, [cat.name, cat.slug, cat.description, true, categories.indexOf(cat)]);
      categoryIds[cat.slug] = result.rows[0]?.id;
      console.log(`   ✓ Category: ${cat.name}`);
    }
    console.log('');

    // ============================================================
    // 4. Create Products
    // ============================================================
    console.log('📦 Creating products...');
    const products = [
      {
        name: 'Casque Audio Sans Fil Pro',
        slug: 'casque-audio-sans-fil-pro',
        description: 'Casque audio Bluetooth de haute qualité avec réduction de bruit active, autonomie 30h et son Hi-Res. Confort premium avec coussinets en mousse mémoire.',
        shortDescription: 'Casque Bluetooth Hi-Res avec ANC - 30h autonomie',
        price: 149.99,
        compareAtPrice: 199.99,
        costPrice: 65.00,
        sku: 'AUD-001',
        categorySlug: 'electronique',
        stock: 45,
        tags: ['audio', 'bluetooth', 'sans-fil', 'anc'],
        isFeatured: true,
      },
      {
        name: 'Montre Connectée Sport',
        slug: 'montre-connectee-sport',
        description: 'Montre connectée avec GPS intégré, suivi de la fréquence cardiaque, 50+ modes sportifs et autonomie 14 jours. Résistante à l\'eau 5ATM.',
        shortDescription: 'Smartwatch GPS avec 50+ sports - Autonomie 14 jours',
        price: 129.99,
        compareAtPrice: 169.99,
        costPrice: 52.00,
        sku: 'MNT-001',
        categorySlug: 'electronique',
        stock: 30,
        tags: ['montre', 'sport', 'gps', 'fitness'],
        isFeatured: true,
      },
      {
        name: 'Enceinte Portable Waterproof',
        slug: 'enceinte-portable-waterproof',
        description: 'Enceinte Bluetooth portable avec son 360°, étanche IP67, autonomie 24h et fonction powerbank. Parfaite pour l\'extérieur.',
        shortDescription: 'Enceinte Bluetooth IP67 - Son 360° - 24h',
        price: 79.99,
        compareAtPrice: null,
        costPrice: 28.00,
        sku: 'AUD-002',
        categorySlug: 'electronique',
        stock: 60,
        tags: ['enceinte', 'bluetooth', 'waterproof', 'portable'],
        isFeatured: false,
      },
      {
        name: 'Clavier Mécanique RGB',
        slug: 'clavier-mecanique-rgb',
        description: 'Clavier mécanique gaming avec switches Cherry MX, rétroéclairage RGB personnalisable, repose-poignets magnétique et construction en aluminium.',
        shortDescription: 'Clavier mécanique Cherry MX RGB - Aluminium',
        price: 119.99,
        compareAtPrice: 149.99,
        costPrice: 55.00,
        sku: 'PER-001',
        categorySlug: 'electronique',
        stock: 25,
        tags: ['clavier', 'mécanique', 'gaming', 'rgb'],
        isFeatured: false,
      },
      {
        name: 'Veste Imperméable Ultra-Légère',
        slug: 'veste-impermeable-ultra-legere',
        description: 'Veste imperméable et respirante de seulement 200g, coupe-vent avec capuche rabattable. Idéale pour le trekking et les activités outdoor.',
        shortDescription: 'Veste coupe-vent 200g - Imperméable & respirante',
        price: 89.99,
        compareAtPrice: 119.99,
        costPrice: 32.00,
        sku: 'VET-001',
        categorySlug: 'vetements',
        stock: 40,
        tags: ['veste', 'imperméable', 'outdoor', 'légère'],
        isFeatured: true,
      },
      {
        name: 'T-shirt Technique Sport',
        slug: 'tshirt-technique-sport',
        description: 'T-shirt en tissu technique respirant avec technologie anti-odeur, coupe ergonomique et séchage rapide. Disponible en plusieurs coloris.',
        shortDescription: 'T-shirt respirant anti-odeur - Séchage rapide',
        price: 29.99,
        compareAtPrice: null,
        costPrice: 8.50,
        sku: 'VET-002',
        categorySlug: 'vetements',
        stock: 150,
        tags: ['tshirt', 'sport', 'technique', 'respirant'],
        isFeatured: false,
      },
      {
        name: 'Lampe de Bureau LED Connectée',
        slug: 'lampe-bureau-led-connectee',
        description: 'Lampe de bureau LED avec contrôle tactile, 5 modes d\'éclairage, chargeur sans fil intégré et minuterie automatique. Design minimaliste.',
        shortDescription: 'Lampe LED 5 modes avec chargeur sans fil',
        price: 59.99,
        compareAtPrice: 79.99,
        costPrice: 22.00,
        sku: 'MAI-001',
        categorySlug: 'maison-jardin',
        stock: 35,
        tags: ['lampe', 'led', 'bureau', 'connectée'],
        isFeatured: false,
      },
      {
        name: 'Tapis de Yoga Premium',
        slug: 'tapis-yoga-premium',
        description: 'Tapis de yoga en TPE écologique, épaisseur 6mm, antidérapant double face avec marquages d\'alignement. Sangle de transport incluse.',
        shortDescription: 'Tapis TPE 6mm antidérapant - Écologique',
        price: 39.99,
        compareAtPrice: 49.99,
        costPrice: 12.00,
        sku: 'SPO-001',
        categorySlug: 'sports-loisirs',
        stock: 80,
        tags: ['yoga', 'fitness', 'tapis', 'écologique'],
        isFeatured: false,
      },
      {
        name: 'Set Soins Visage Bio',
        slug: 'set-soins-visage-bio',
        description: 'Kit complet de soins du visage certifié bio : nettoyant moussant, sérum vitamine C, crème hydratante et masque purifiant.',
        shortDescription: 'Kit 4 soins visage certifiés bio',
        price: 49.99,
        compareAtPrice: 69.99,
        costPrice: 18.00,
        sku: 'BEA-001',
        categorySlug: 'beaute-sante',
        stock: 55,
        tags: ['soins', 'visage', 'bio', 'cosmétiques'],
        isFeatured: true,
      },
      {
        name: 'Caméra de Sécurité WiFi',
        slug: 'camera-securite-wifi',
        description: 'Caméra de surveillance Full HD 1080p, vision nocturne, détection de mouvement, audio bidirectionnel et stockage cloud/local.',
        shortDescription: 'Caméra Full HD avec vision nocturne & audio',
        price: 69.99,
        compareAtPrice: 99.99,
        costPrice: 25.00,
        sku: 'MAI-002',
        categorySlug: 'maison-jardin',
        stock: 20,
        tags: ['caméra', 'sécurité', 'wifi', 'surveillance'],
        isFeatured: false,
      },
    ];

    for (const product of products) {
      await database.query(`
        INSERT INTO products (
          id, name, slug, description, short_description, sku,
          price, compare_at_price, cost_price, category_id,
          images, stock_quantity, low_stock_threshold,
          is_active, is_featured, tags
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (sku) DO NOTHING
      `, [
        uuidv4(),
        product.name,
        product.slug,
        product.description,
        product.shortDescription,
        product.sku,
        product.price,
        product.compareAtPrice,
        product.costPrice,
        categoryIds[product.categorySlug],
        [],
        product.stock,
        10,
        true,
        product.isFeatured,
        product.tags,
      ]);
      console.log(`   ✓ Product: ${product.name} (${product.sku}) - €${product.price}`);
    }
    console.log('');

    console.log('✅ Seeding completed successfully!');
    console.log('');
    console.log('Summary:');
    console.log('  - 1 admin user (admin@ecommerce-platform.com)');
    console.log(`  - ${customers.length} test customers`);
    console.log(`  - ${categories.length} categories`);
    console.log(`  - ${products.length} products`);
    console.log('');

  } catch (error) {
    console.error('❌ Seeding failed:', error.message);
    process.exit(1);
  } finally {
    await database.disconnect();
  }
}

seed();
