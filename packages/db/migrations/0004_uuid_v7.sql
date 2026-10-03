-- UUIDv7 (RFC 9562) as default primary key for tenant tables (decision #033):
-- 48 bits of Unix time in milliseconds, then version 7 and random bits.
-- PostgreSQL 17 has no built-in uuidv7(); on PG18, replace the body with it.
-- Starts from a random v4 (correct variant bits), overwrites the first six
-- bytes with the timestamp and sets the version nibble to 7.
CREATE OR REPLACE FUNCTION public.gen_uuid_v7() RETURNS uuid
LANGUAGE plpgsql VOLATILE PARALLEL SAFE
SET search_path = pg_catalog
AS $$
DECLARE
  unix_ms bigint := floor(extract(epoch FROM clock_timestamp()) * 1000);
  bytes bytea := uuid_send(gen_random_uuid());
BEGIN
  bytes := overlay(bytes PLACING substring(int8send(unix_ms) FROM 3) FROM 1 FOR 6);
  bytes := set_byte(bytes, 6, (get_byte(bytes, 6) & 15) | 112);
  RETURN encode(bytes, 'hex')::uuid;
END
$$;
