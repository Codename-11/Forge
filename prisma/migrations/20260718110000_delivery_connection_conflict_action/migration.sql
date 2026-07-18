-- Typed operator decisions for blocked managed-runtime delivery attempts.
ALTER TYPE "ActionRequestKind" ADD VALUE IF NOT EXISTS 'DELIVERY_CONNECTION_CONFLICT';
