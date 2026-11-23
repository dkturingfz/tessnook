#!/usr/bin/env bash
# 在任意 PostgreSQL 15+ 上验证迁移、RLS 与 RPC。用法：
#   PGURL=postgres://postgres@localhost:5432/postgres scripts/test-db.sh
set -euo pipefail
PGURL="${PGURL:-postgres://postgres@localhost:5432/postgres}"
DB=spatial_board_test
psql "$PGURL" -q -c "drop database if exists $DB" -c "create database $DB"
BASE="${PGURL%%\?*}"; QUERY="${PGURL#"$BASE"}"
TEST_URL="${BASE%/*}/$DB$QUERY"
psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/auth_stub.sql
for f in supabase/migrations/*.sql; do psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -f "$f"; done
psql "$TEST_URL" -v ON_ERROR_STOP=1 -q -f supabase/tests/rls_and_rpc.test.sql
