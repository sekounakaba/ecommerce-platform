-- ============================================================
-- E-Commerce Platform - Database Initialization
-- This script runs when the PostgreSQL container is first created
-- ============================================================

-- Create the application database user if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'ecommerce_user') THEN
        CREATE ROLE ecommerce_user WITH LOGIN PASSWORD 'ecommerce_secure_password_2024';
    END IF;
END
$$;

-- Create the application database if it doesn't exist
SELECT 'CREATE DATABASE ecommerce_db OWNER ecommerce_user'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ecommerce_db')\gexec

-- Grant necessary permissions
GRANT ALL PRIVILEGES ON DATABASE ecommerce_db TO ecommerce_user;

-- Connect to the application database and set up schema
\c ecommerce_db;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- For trigram-based similarity searches
CREATE EXTENSION IF NOT EXISTS "citext";   -- For case-insensitive email comparisons

-- Grant schema permissions
GRANT ALL ON SCHEMA public TO ecommerce_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ecommerce_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ecommerce_user;
